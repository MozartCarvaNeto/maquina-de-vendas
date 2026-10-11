// backend/src/services/ai/compatProviders.js
//
// Provedores "estilo OpenAI": cada um é só um endereço + modelo padrão.
// Para incluir mais um no futuro, acrescente uma linha em COMPAT_DEFS.
const OpenAiCompatibleProvider = require('./OpenAiCompatibleProvider');

const COMPAT_DEFS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    extraHeaders: { 'X-Title': 'Turbo Prospect' }
  },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest' },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini' },
  together: { baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  // Qualquer serviço compatível (Ollama, LM Studio, vLLM, Azure...). O cliente informa o endereço.
  custom: { baseUrl: '', defaultModel: '' }
};

const compatProviders = {};
for (const [id, def] of Object.entries(COMPAT_DEFS)) {
  const Cls = class extends OpenAiCompatibleProvider {};
  Cls.providerId = id;
  Cls.baseUrl = def.baseUrl;
  Cls.defaultModel = def.defaultModel;
  Cls.extraHeaders = def.extraHeaders || {};
  compatProviders[id] = Cls;
}

module.exports = compatProviders;
