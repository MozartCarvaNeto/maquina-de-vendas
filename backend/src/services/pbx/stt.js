// backend/src/services/pbx/stt.js
// Reconhecimento de fala (o Asterisk não entende palavras; o portal transcreve o que o cliente disse).
// Usa o Gemini (mesma chave das vozes da IA). Se houver chave da OpenAI cadastrada, o Whisper também funciona.
const { buildWav } = require('./wav');
const { readStoredCredentials } = require('../settingsHelpers');

async function geminiKey(userId) {
  const stored = await readStoredCredentials(userId, 'ai', 'gemini').catch(() => ({}));
  return stored.apiKey || process.env.GEMINI_API_KEY || null;
}

async function openaiKey(userId) {
  const stored = await readStoredCredentials(userId, 'ai', 'openai').catch(() => ({}));
  return stored.apiKey || process.env.OPENAI_API_KEY || null;
}

async function viaGemini(apiKey, wav, language, hints) {
  const models = [process.env.GEMINI_STT_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean);
  let last;
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Transcreva exatamente o que a pessoa disse neste áudio de ligação telefônica (idioma ${language}). Responda SOMENTE com a transcrição, sem aspas nem comentários. Se não houver fala compreensível, responda vazio.${hints ? ` Termos que podem aparecer: ${hints}.` : ''}`
              },
              { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }
            ]
          }
        ],
        generationConfig: { temperature: 0 }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim();
    last = new Error(`Gemini ${res.status}: ${data?.error?.message || ''}`);
    if (![400, 404].includes(res.status)) break;
  }
  throw last;
}

async function viaWhisper(apiKey, wav, language) {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', String(language).slice(0, 2));
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'fala.wav');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || ''}`);
  return String(data.text || '').trim();
}

/** pcm = Buffer de 16 bits mono 8 kHz. Devolve o texto ('' se não entendeu). */
async function transcribe(userId, pcm, { language = 'pt-BR', hints = '', provider = 'auto' } = {}) {
  const engines = require('./voiceEngines');
  if (provider === 'google') return engines.sttGoogle(userId, pcm, language);
  if (provider === 'azure') return engines.sttAzure(userId, pcm, language);
  const wav = buildWav(pcm, 8000);
  if (provider === 'openai') {
    const k = await openaiKey(userId);
    if (!k) throw new Error('Sem chave da OpenAI (Configurações > Inteligência Artificial).');
    return viaWhisper(k, wav, language);
  }
  const oKey = await openaiKey(userId);
  const gKey = await geminiKey(userId);
  if (!gKey && !oKey) throw new Error('Sem chave do Gemini (ou OpenAI) para entender a fala. Cadastre em Configurações > Inteligência Artificial.');
  if (gKey) {
    try {
      return await viaGemini(gKey, wav, language, hints);
    } catch (e) {
      if (!oKey) throw e;
    }
  }
  return viaWhisper(oKey, wav, language);
}

module.exports = { transcribe };
