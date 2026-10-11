// backend/src/services/ai/providerMeta.js
// Nomes e dicas mostrados na tela. (O frontend tem uma cópia em utils/aiProviders.js.)
module.exports = {
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash' },
  openai: { label: 'OpenAI ChatGPT', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic Claude', model: 'claude-haiku-4-5' },
  groq: { label: 'Groq (Llama — muito rápido)', model: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter (vários modelos)', model: 'openai/gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat' },
  mistral: { label: 'Mistral AI', model: 'mistral-small-latest' },
  xai: { label: 'xAI Grok', model: 'grok-3-mini' },
  together: { label: 'Together AI', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  custom: { label: 'Outro (compatível com OpenAI)', model: '', needsBaseUrl: true }
};
