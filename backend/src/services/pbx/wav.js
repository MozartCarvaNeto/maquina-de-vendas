// backend/src/services/pbx/wav.js
// Leitura/escrita de WAV em JavaScript puro e conversão para o formato do Asterisk (8 kHz, 16 bits, mono).
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ULAW = new Int16Array(256);
const ALAW = new Int16Array(256);
(function init() {
  for (let i = 0; i < 256; i += 1) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 7;
    const man = u & 15;
    let s = ((man << 3) + 0x84) << exp;
    s -= 0x84;
    ULAW[i] = sign ? -s : s;
    let a = i ^ 0x55;
    const asign = a & 0x80;
    const aexp = (a >> 4) & 7;
    const aman = a & 15;
    let v = aexp === 0 ? (aman << 4) + 8 : ((aman << 4) + 0x108) << (aexp - 1);
    ALAW[i] = asign ? v : -v;
  }
})();

function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Arquivo não é um WAV válido.');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === 'data' && (size === 0 || start + size > buf.length)) size = buf.length - start; // streams sem tamanho
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14)
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV incompleto (sem fmt/data).');
  return { ...fmt, data };
}

/** Converte qualquer WAV (PCM 8/16/24 bits, µ-law, A-law) em amostras Int16 mono 8 kHz. */
function wavToSlin8k(buf) {
  const w = parseWav(buf);
  const bytes = w.format === 7 || w.format === 6 ? 1 : w.bits / 8;
  if (![1, 2, 3].includes(bytes) || ![1, 6, 7].includes(w.format)) throw new Error('Formato de WAV não suportado.');
  const frames = Math.floor(w.data.length / (bytes * w.channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let acc = 0;
    for (let c = 0; c < w.channels; c += 1) {
      const o = (i * w.channels + c) * bytes;
      let v;
      if (w.format === 7) v = ULAW[w.data[o]];
      else if (w.format === 6) v = ALAW[w.data[o]];
      else if (bytes === 1) v = (w.data[o] - 128) << 8;
      else if (bytes === 2) v = w.data.readInt16LE(o);
      else v = w.data.readIntLE(o, 3) >> 8;
      acc += v;
    }
    mono[i] = acc / w.channels;
  }
  const ratio = w.sampleRate / 8000;
  if (ratio === 1) return Int16Array.from(mono, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
  const outLen = Math.floor(frames / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    // média da janela quando reduz (filtro simples contra chiado); interpolação linear quando aumenta
    if (ratio > 1) {
      const a = Math.floor(pos);
      const b = Math.min(frames, Math.max(a + 1, Math.floor(pos + ratio)));
      let s = 0;
      for (let k = a; k < b; k += 1) s += mono[k];
      out[i] = Math.round(s / (b - a));
    } else {
      const a = Math.floor(pos);
      const f = pos - a;
      const v = mono[a] * (1 - f) + (mono[Math.min(frames - 1, a + 1)] || 0) * f;
      out[i] = Math.round(v);
    }
  }
  return out;
}

function int16ToBuffer(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) b.writeInt16LE(samples[i], i * 2);
  return b;
}

function bufferToInt16(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function buildWav(pcmBuf, sampleRate = 8000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcmBuf.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([h, pcmBuf]);
}

/** Usa o ffmpeg (mp3, ogg, m4a, webm...) para chegar ao WAV 8 kHz mono. */
function ffmpegToWav8k(input, ext = '.bin') {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `pbx-${crypto.randomUUID()}${ext}`);
    const tmpOut = `${tmpIn}.wav`;
    const cleanup = () => {
      fs.rm(tmpIn, { force: true }, () => null);
      fs.rm(tmpOut, { force: true }, () => null);
    };
    fs.writeFileSync(tmpIn, input);
    const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpIn, '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', tmpOut]);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
    proc.on('error', () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Esse formato precisa do ffmpeg instalado no servidor (apt install ffmpeg) — ou envie um arquivo .wav.'));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('Não consegui converter esse áudio. Tente enviar em .wav ou .mp3.');
        const out = fs.readFileSync(tmpOut);
        resolve(out);
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    });
  });
}

/** Qualquer áudio enviado -> WAV 8 kHz mono 16 bits (o formato que o Asterisk toca sem recodificar). */
async function normalizeToAsteriskWav(input, filename = '') {
  let wav = null;
  try {
    wav = buildWav(int16ToBuffer(wavToSlin8k(input)), 8000);
  } catch (_) {
    const ext = (path.extname(filename) || '.bin').toLowerCase().replace(/[^.a-z0-9]/g, '');
    const converted = await ffmpegToWav8k(input, ext || '.bin');
    wav = buildWav(int16ToBuffer(wavToSlin8k(converted)), 8000);
  }
  return { wav, durationMs: Math.round(((wav.length - 44) / 2 / 8000) * 1000) };
}

module.exports = { parseWav, wavToSlin8k, int16ToBuffer, bufferToInt16, buildWav, normalizeToAsteriskWav };
