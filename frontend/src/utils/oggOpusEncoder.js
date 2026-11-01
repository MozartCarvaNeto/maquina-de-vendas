// frontend/src/utils/oggOpusEncoder.js
//
// Transforma o áudio gravado no navegador (WEBM no Chrome/Android, M4A no Safari) em OGG/Opus — o formato exato
// da mensagem de voz do WhatsApp — SEM precisar do ffmpeg no servidor. Usa o codificador Opus do próprio
// navegador (WebCodecs) e monta o arquivo OGG aqui mesmo. Se o navegador não tiver WebCodecs, devolve null e o
// chamador segue com o caminho antigo (o servidor converte, se tiver ffmpeg).
const SAMPLE_RATE = 48000;
const FRAME = 960; // 20 ms a 48 kHz
const PRE_SKIP = 312;

export async function canEncodeOpus() {
  try {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
    const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32000 });
    return !!r.supported;
  } catch {
    return false;
  }
}

// ---------- container OGG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  return crc >>> 0;
}

/** Monta uma página OGG com `packets` (cada pacote inteiro dentro da página). */
function oggPage({ packets, granule, serial, sequence, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let len = p.length;
    while (len >= 255) { lacing.push(255); len -= 255; }
    lacing.push(len);
  }
  const bodyLen = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0;
  page[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 4294967296) >>> 0, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true); // CRC (preenchido abaixo)
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const p of packets) { page.set(p, offset); offset += p.length; }
  view.setUint32(22, crc32(page), true);
  return page;
}

function buildOggOpus(opusPackets, totalSamples) {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1; // versão
  head[9] = 1; // canais
  new DataView(head.buffer).setUint16(10, PRE_SKIP, true);
  new DataView(head.buffer).setUint32(12, SAMPLE_RATE, true);
  head[16] = 0; head[17] = 0; head[18] = 0; // ganho 0, mapeamento 0

  const vendor = new TextEncoder().encode('TurboProspect');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  new DataView(tags.buffer).setUint32(12 + vendor.length, 0, true);

  const pages = [
    oggPage({ packets: [head], granule: 0, serial, sequence: 0, bos: true }),
    oggPage({ packets: [tags], granule: 0, serial, sequence: 1 })
  ];

  const PER_PAGE = 25; // 25 pacotes de 20 ms = 0,5 s por página
  let sequence = 2;
  let samples = 0;
  for (let i = 0; i < opusPackets.length; i += PER_PAGE) {
    const group = opusPackets.slice(i, i + PER_PAGE);
    const last = i + PER_PAGE >= opusPackets.length;
    samples += group.length * FRAME;
    pages.push(oggPage({ packets: group, granule: last ? Math.max(totalSamples, 0) + PRE_SKIP : samples, serial, sequence, eos: last }));
    sequence += 1;
  }

  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pages) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Lê o áudio gravado e devolve PCM mono de 48 kHz. */
async function decodeToMono48k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c += 1) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / audio.numberOfChannels;
    }
    return mono;
  } finally {
    ctx.close?.();
  }
}

/**
 * Converte a gravação em um File OGG/Opus pronto para virar mensagem de voz.
 * Devolve null se o navegador não conseguir (aí o chamador usa o plano B).
 */
export async function recordingToOggOpus(blob, fileName = 'audio.ogg') {
  if (!(await canEncodeOpus())) return null;
  try {
    const pcm = await decodeToMono48k(blob);
    if (!pcm.length) return null;

    const packets = [];
    let encoderError = null;
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        packets.push(buf);
      },
      error: (e) => { encoderError = e; }
    });
    encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32000 });

    for (let start = 0; start < pcm.length; start += FRAME) {
      const frame = new Float32Array(FRAME); // última parte é completada com silêncio
      frame.set(pcm.subarray(start, Math.min(start + FRAME, pcm.length)));
      const data = new AudioData({
        format: 'f32',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME,
        numberOfChannels: 1,
        timestamp: Math.round((start / SAMPLE_RATE) * 1e6),
        data: frame
      });
      encoder.encode(data);
      data.close();
      if (encoderError) throw encoderError;
    }
    await encoder.flush();
    encoder.close();
    if (encoderError || packets.length === 0) return null;

    const ogg = buildOggOpus(packets, pcm.length);
    return new File([ogg], fileName, { type: 'audio/ogg' });
  } catch (error) {
    console.warn('Não consegui converter o áudio no navegador:', error?.message || error);
    return null;
  }
}
