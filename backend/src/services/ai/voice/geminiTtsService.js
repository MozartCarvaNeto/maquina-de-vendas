// backend/src/services/ai/voice/geminiTtsService.js
//
// Voz do Gemini (Google) para a ligação da IA — bem mais natural que a Amazon Polly.
// Como funciona: o texto vira um áudio (WAV), guardado em uploads/ai-tts, e a operadora TOCA esse áudio
// (<Play>) no lugar do <Say>. Se qualquer coisa falhar (sem chave, sem cota, demora), a ligação segue
// com a voz padrão (Polly) — a conversa nunca cai por causa da voz.
//
// Seleção no agente: voz "gemini:Kore" (ou outro nome de voz do Gemini).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readStoredCredentials } = require('../../settingsHelpers');

const TTS_DIR = path.join(__dirname, '../../../../uploads/ai-tts');
const API = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 8000;
const FILE_TTL_MS = 12 * 60 * 60 * 1000;

// Modelos de voz, do mais indicado para conversa por telefone (rápido e barato) ao mais antigo.
// Pode ser fixado com a variável GEMINI_TTS_MODEL no .env.
const MODEL_CANDIDATES = [
  process.env.GEMINI_TTS_MODEL,
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
  'gemini-3.1-flash-tts-preview'
].filter(Boolean);

let workingModel = null;

// Vozes prontas do Gemini (nome → característica).
const PREBUILT_VOICES = {
  Achird: 'Amigável', Sulafat: 'Calorosa', Kore: 'Firme', Aoede: 'Leve', Puck: 'Animada', Zephyr: 'Brilhante',
  Charon: 'Informativa', Fenrir: 'Empolgada', Leda: 'Jovem', Orus: 'Firme', Callirrhoe: 'Descontraída',
  Autonoe: 'Brilhante', Enceladus: 'Suave (soprada)', Iapetus: 'Clara', Umbriel: 'Descontraída', Algieba: 'Suave',
  Despina: 'Suave', Erinome: 'Clara', Algenib: 'Rouca', Rasalgethi: 'Informativa', Laomedeia: 'Animada',
  Achernar: 'Macia', Alnilam: 'Firme', Schedar: 'Uniforme', Gacrux: 'Madura', Pulcherrima: 'Direta',
  Zubenelgenubi: 'Casual', Vindemiatrix: 'Gentil', Sadachbia: 'Viva', Sadaltager: 'Conhecedora'
};

function publicBaseUrl() {
  return String(process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
}

async function getApiKey(userId) {
  const stored = userId ? await readStoredCredentials(userId, 'ai', 'gemini').catch(() => ({})) : {};
  return stored.apiKey || process.env.GEMINI_API_KEY || null;
}

function fileKey(model, voice, text) {
  const secret = process.env.JWT_SECRET || 'tts';
  return crypto.createHmac('sha256', secret).update(`${model}|${voice}|${text}`).digest('hex').slice(0, 40);
}

function ensureDir() {
  fs.mkdirSync(TTS_DIR, { recursive: true });
}

/** O Gemini devolve WAV 24 kHz; para telefone convertemos para 8 kHz µ-law (menor e mais rápido de tocar). */
function toTelephonyWav(wavBuffer) {
  return new Promise((resolve) => {
    const tmpIn = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.wav`);
    const tmpOut = `${tmpIn}.out.wav`;
    try {
      fs.writeFileSync(tmpIn, wavBuffer);
    } catch (_) {
      return resolve(wavBuffer);
    }
    const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpIn, '-ar', '8000', '-ac', '1', '-c:a', 'pcm_mulaw', tmpOut]);
    const cleanup = () => {
      fs.rm(tmpIn, { force: true }, () => null);
      fs.rm(tmpOut, { force: true }, () => null);
    };
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
    proc.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(wavBuffer); // sem ffmpeg: toca o WAV original
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let out = wavBuffer;
      try {
        if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 44) out = fs.readFileSync(tmpOut);
      } catch (_) {
        /* mantém o original */
      }
      cleanup();
      resolve(out);
    });
  });
}

async function requestSpeech(apiKey, model, text, voice) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.error?.message || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const audioBlocks = [];
    for (const step of data.steps || []) {
      for (const block of step.content || []) if (block?.type === 'audio' && block.data) audioBlocks.push(block);
    }
    const last = audioBlocks[audioBlocks.length - 1];
    if (!last) throw new Error('O Gemini não devolveu áudio.');
    return Buffer.from(last.data, 'base64');
  } finally {
    clearTimeout(timer);
  }
}

/** Gera (ou pega do cache) o áudio de uma fala. Devolve o WAV pronto para telefone. */
async function synthesizeWav(userId, text, voice) {
  const apiKey = await getApiKey(userId);
  if (!apiKey) throw new Error('Sem chave do Gemini cadastrada (Configurações > Inteligência Artificial).');

  const models = workingModel ? [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)] : MODEL_CANDIDATES;
  let lastError;
  for (const model of models) {
    try {
      const wav = await requestSpeech(apiKey, model, text, voice);
      workingModel = model;
      return { wav, model };
    } catch (error) {
      lastError = error;
      // Modelo inexistente/sem acesso: tenta o próximo. Outros erros (chave, cota, rede): para aqui.
      if (![400, 404].includes(error.status)) break;
    }
  }
  throw lastError || new Error('Falha ao gerar a voz.');
}

/**
 * Devolve a URL pública do áudio da fala (gera se ainda não existir).
 * Lança erro se não conseguir — quem chama deve cair para a voz padrão.
 */
async function getSpeechUrl(userId, text, voice) {
  const base = publicBaseUrl();
  if (!/^https?:\/\//i.test(base) || /localhost|127\.0\.0\.1/i.test(base)) {
    throw new Error('BACKEND_PUBLIC_URL precisa ser público para tocar áudio na ligação.');
  }
  ensureDir();
  const key = fileKey(workingModel || MODEL_CANDIDATES[0], voice, text);
  const file = path.join(TTS_DIR, `${key}.wav`);
  if (!fs.existsSync(file)) {
    const { wav, model } = await synthesizeWav(userId, text, voice);
    const phoneWav = await toTelephonyWav(wav);
    // O nome usa o modelo que realmente gerou; se mudou, grava também sob a chave nova.
    const realKey = fileKey(model, voice, text);
    fs.writeFileSync(path.join(TTS_DIR, `${realKey}.wav`), phoneWav);
    if (realKey !== key) fs.writeFileSync(file, phoneWav);
  }
  return `${base}/api/ai-calls/tts/${key}.wav`;
}

/** Áudio de amostra (para "ouvir voz" no editor do agente). WAV 24 kHz, sem conversão. */
async function previewWav(userId, text, voice) {
  const { wav } = await synthesizeWav(userId, text, voice);
  return wav;
}

/** Vozes da biblioteca ampliada do Gemini para um idioma (ex.: pt-BR). Falha = lista vazia. */
async function listLibraryVoices(userId, languageCode = 'pt-BR') {
  const apiKey = await getApiKey(userId);
  if (!apiKey) return [];
  try {
    const url = `${API}/voices?language_code=${encodeURIComponent(languageCode)}&type=prebuilt&page_size=100`;
    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.voices || []).map((v) => ({
      id: v.id,
      name: v.display_name || v.id,
      description: v.description || '',
      gender: v.gender || '',
      accent: v.accent || ''
    }));
  } catch (_) {
    return [];
  }
}

/** Caminho seguro de um arquivo de áudio gerado (só nomes no formato esperado). */
function resolveFile(name) {
  if (!/^[a-f0-9]{40}\.wav$/.test(String(name || ''))) return null;
  const full = path.join(TTS_DIR, name);
  return fs.existsSync(full) ? full : null;
}

/** Faz a troca dos <Say> marcados (data-tts) por <Play> do áudio gerado. Se falhar, mantém a voz padrão. */
async function speechify(xml) {
  if (!xml || !xml.includes('data-tts=')) return xml;
  const re = /<Say\b([^>]*?)\sdata-tts="gemini:([^"|]*)\|([^"]*)"([^>]*)>([\s\S]*?)<\/Say>/g;
  const matches = [...xml.matchAll(re)];
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  const results = await Promise.all(
    matches.map(async (m) => {
      try {
        const url = await getSpeechUrl(m[3], unescape(m[5]), m[2] || 'Kore');
        return `<Play>${url}</Play>`;
      } catch (error) {
        console.warn(`⚠️ Voz Gemini indisponível, usando a voz padrão: ${error.message}`);
        return `<Say${m[1]}${m[4]}>${m[5]}</Say>`;
      }
    })
  );
  let i = 0;
  return xml.replace(re, () => results[i++]);
}

// Limpeza dos áudios antigos (os arquivos só precisam existir durante a ligação).
const cleanupTimer = setInterval(() => {
  try {
    if (!fs.existsSync(TTS_DIR)) return;
    const limit = Date.now() - FILE_TTL_MS;
    for (const name of fs.readdirSync(TTS_DIR)) {
      const full = path.join(TTS_DIR, name);
      if (fs.statSync(full).mtimeMs < limit) fs.rmSync(full, { force: true });
    }
  } catch (_) {
    /* limpeza é só uma gentileza */
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

module.exports = { PREBUILT_VOICES, getSpeechUrl, previewWav, listLibraryVoices, resolveFile, speechify };
