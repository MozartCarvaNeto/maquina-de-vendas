// backend/src/services/pbx/voiceEngines.js
// Vozes (texto → fala) e reconhecimento de fala para as ligações da IA pelo Asterisk.
// Cada voz é identificada por um texto:
//   gemini:Kore · Google.pt-BR-Chirp3-HD-Aoede (ou google:pt-BR-Neural2-A) · Polly.Camila-Neural (ou polly:Camila-Neural)
//   azure:pt-BR-FranciscaNeural · elevenlabs:<voiceId> · openai:alloy
const crypto = require('crypto');
const { readStoredCredentials } = require('../settingsHelpers');
const { buildWav, wavToSlin8k, int16ToBuffer, bufferToInt16 } = require('./wav');

const TIMEOUT = 15000;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fail = (msg, status = 502) => Object.assign(new Error(msg), { status });

/** Chave do próprio cliente (se houver); senão a da plataforma — o cliente usa por créditos, sem cadastrar chaves. */
async function creds(userId, provider) {
  const own = await readStoredCredentials(userId, 'voice_engines', provider).catch(() => ({}));
  if (own && Object.keys(own).length) return own;
  for (const pid of await require('../platformService').platformAccountIds()) {
    if (pid === userId) continue;
    const c = await readStoredCredentials(pid, 'voice_engines', provider).catch(() => ({}));
    if (c && Object.keys(c).length) return c;
  }
  return own || {};
}

async function googleKey(userId) {
  const own = await creds(userId, 'google');
  if (own.apiKey) return own.apiKey;
  const g = await readStoredCredentials(userId, 'ai', 'gemini').catch(() => ({}));
  return g.apiKey || process.env.GEMINI_API_KEY || null;
}

async function http(url, opts, label) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw fail(`${label}: sem resposta (${e.message}).`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    let detail = txt.slice(0, 200);
    try {
      const j = JSON.parse(txt);
      detail = j?.error?.message || j?.message || j?.Message || j?.detail?.message || detail;
    } catch (_) { /* texto puro */ }
    throw fail(`${label}: ${res.status === 401 || res.status === 403 ? 'chave/permissão recusada' : `erro ${res.status}`}${detail ? ` — ${detail}` : ''}`);
  }
  return res;
}

// ------------------------------------------------------------------ Amazon (assinatura SigV4, sem SDK)
function sha256hex(d) { return crypto.createHash('sha256').update(d).digest('hex'); }
function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }

function signAws({ method, host, path = '/', query = '', headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, amzDate }) {
  const date = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const stamp = date.slice(0, 8);
  const h = { host, 'x-amz-date': date, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  if (sessionToken) h['x-amz-security-token'] = sessionToken;
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [method, path, query, canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = `${stamp}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, stamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    headers: { ...h, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    signature
  };
}

async function viaPolly(userId, voice, text, language) {
  const c = await creds(userId, 'polly');
  if (!c.accessKeyId || !c.secret) throw fail('Amazon Polly: cadastre a chave de acesso da AWS (Telefonia PBX → Vozes e fala).', 400);
  const region = c.region || 'us-east-1';
  const neural = /-neural$/i.test(voice);
  const voiceId = voice.replace(/-neural$/i, '');
  const host = `polly.${region}.amazonaws.com`;
  const body = JSON.stringify({ OutputFormat: 'pcm', SampleRate: '8000', Text: text, VoiceId: voiceId, Engine: neural ? 'neural' : 'standard', LanguageCode: language || 'pt-BR' });
  const { headers } = signAws({ method: 'POST', host, path: '/v1/speech', headers: { 'content-type': 'application/json' }, body, region, service: 'polly', accessKeyId: c.accessKeyId, secretAccessKey: c.secret });
  const res = await http(`https://${host}/v1/speech`, { method: 'POST', headers, body }, 'Amazon Polly');
  return Buffer.from(await res.arrayBuffer()); // PCM 16 bits 8 kHz
}

// ------------------------------------------------------------------ Microsoft Azure
async function viaAzure(userId, voice, text, language) {
  const c = await creds(userId, 'azure');
  if (!c.apiKey || !c.region) throw fail('Microsoft Azure: cadastre a chave e a região do serviço Speech (Telefonia PBX → Vozes e fala).', 400);
  const lang = language || voice.split('-').slice(0, 2).join('-') || 'pt-BR';
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${esc(lang)}"><voice name="${esc(voice)}">${esc(text)}</voice></speak>`;
  const res = await http(
    `https://${c.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': c.apiKey, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-8khz-16bit-mono-pcm', 'User-Agent': 'turbo-prospect' }, body: ssml },
    'Microsoft Azure'
  );
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------ Google Cloud
async function viaGoogle(userId, voice, text, language) {
  const key = await googleKey(userId);
  if (!key) throw fail('Google: cadastre a chave do Google Cloud (ou a do Gemini) com a "Cloud Text-to-Speech API" ativada.', 400);
  const lang = language || voice.split('-').slice(0, 2).join('-') || 'pt-BR';
  const res = await http(
    'https://texttospeech.googleapis.com/v1/text:synthesize',
    { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 } }) },
    'Google Cloud TTS'
  );
  const data = await res.json();
  if (!data.audioContent) throw fail('Google Cloud TTS: resposta sem áudio.');
  return int16ToBuffer(wavToSlin8k(Buffer.from(data.audioContent, 'base64')));
}

// ------------------------------------------------------------------ ElevenLabs e OpenAI
async function viaElevenLabs(userId, voiceId, text) {
  const c = await creds(userId, 'elevenlabs');
  if (!c.apiKey) throw fail('ElevenLabs: cadastre a chave (Telefonia PBX → Vozes e fala).', 400);
  const res = await http(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`,
    { method: 'POST', headers: { 'xi-api-key': c.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: c.model || 'eleven_multilingual_v2' }) },
    'ElevenLabs'
  );
  return int16ToBuffer(wavToSlin8k(buildWav(Buffer.from(await res.arrayBuffer()), 16000)));
}

async function viaOpenAi(userId, voice, text) {
  const stored = await readStoredCredentials(userId, 'ai', 'openai').catch(() => ({}));
  const key = stored.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw fail('OpenAI: cadastre a chave em Configurações → Inteligência Artificial.', 400);
  const res = await http(
    'https://api.openai.com/v1/audio/speech',
    { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, response_format: 'wav' }) },
    'OpenAI voz'
  );
  return int16ToBuffer(wavToSlin8k(Buffer.from(await res.arrayBuffer())));
}

async function viaGemini(userId, name, text) {
  const { synthesizeWav } = require('../ai/voice/geminiTtsService');
  const { wav } = await synthesizeWav(userId, text, name || 'Kore');
  return int16ToBuffer(wavToSlin8k(wav));
}

/** Decide o motor pelo identificador da voz. */
function parseVoice(id) {
  const v = String(id || '').trim();
  let m;
  if ((m = /^gemini:(.*)$/i.exec(v))) return { engine: 'gemini', name: m[1] || 'Kore' };
  if ((m = /^google[.:](.+)$/i.exec(v))) return { engine: 'google', name: m[1] };
  if ((m = /^polly[.:](.+)$/i.exec(v))) return { engine: 'polly', name: m[1] };
  if ((m = /^azure:(.+)$/i.exec(v))) return { engine: 'azure', name: m[1] };
  if ((m = /^elevenlabs:(.+)$/i.exec(v))) return { engine: 'elevenlabs', name: m[1] };
  if ((m = /^openai:(.+)$/i.exec(v))) return { engine: 'openai', name: m[1] };
  return { engine: 'gemini', name: 'Kore' };
}

const ENGINES = { gemini: (u, n, t) => viaGemini(u, n, t), google: viaGoogle, polly: viaPolly, azure: viaAzure, elevenlabs: (u, n, t) => viaElevenLabs(u, n, t), openai: (u, n, t) => viaOpenAi(u, n, t) };

// guarda as últimas falas (aberturas e frases repetidas saem na hora e não gastam a cota do fornecedor)
const cache = new Map();
const CACHE_MAX = 80;

/**
 * Texto → áudio PCM 16 bits 8 kHz (Buffer). Se a voz escolhida falhar, tenta a voz Gemini padrão
 * (a ligação não cai por causa da voz); se nenhuma funcionar, o erro da voz escolhida é lançado.
 */
async function synthesize(userId, voiceId, text, { language, fallback = true } = {}) {
  const key = crypto.createHash('sha1').update(`${userId}|${voiceId}|${language || ''}|${text}`).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const { engine, name } = parseVoice(voiceId);
  let pcm;
  try {
    pcm = await ENGINES[engine](userId, name, text, language);
  } catch (e) {
    if (!fallback || engine === 'gemini') throw e;
    console.warn(`⚠️ Voz ${voiceId} falhou (${e.message}); usando a voz padrão.`);
    try {
      pcm = await viaGemini(userId, 'Kore', text);
    } catch (_) {
      throw e;
    }
  }
  cache.set(key, pcm);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return pcm;
}

// ------------------------------------------------------------------ reconhecimento de fala
async function sttGoogle(userId, pcm, language) {
  const key = await googleKey(userId);
  if (!key) throw fail('Google: cadastre a chave do Google Cloud com a "Speech-to-Text API" ativada.', 400);
  const res = await http(
    'https://speech.googleapis.com/v1/speech:recognize',
    { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 8000, languageCode: language || 'pt-BR', model: 'latest_short', enableAutomaticPunctuation: true }, audio: { content: pcm.toString('base64') } }) },
    'Google Speech-to-Text'
  );
  const data = await res.json();
  return (data.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').trim();
}

async function sttAzure(userId, pcm, language) {
  const c = await creds(userId, 'azure');
  if (!c.apiKey || !c.region) throw fail('Microsoft Azure: cadastre a chave e a região do serviço Speech.', 400);
  const res = await http(
    `https://${c.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language || 'pt-BR')}&format=simple`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': c.apiKey, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=8000', Accept: 'application/json' }, body: buildWav(pcm, 8000) },
    'Microsoft Azure STT'
  );
  const data = await res.json();
  return data.RecognitionStatus === 'Success' ? String(data.DisplayText || '').trim() : '';
}

module.exports = { synthesize, parseVoice, sttGoogle, sttAzure, signAws, creds, googleKey, _cache: cache };
