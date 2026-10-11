// frontend/src/utils/aiProviders.js
// Lista das IAs que o sistema sabe usar. Para incluir uma nova, o backend também
// precisa conhecê-la (backend/src/services/ai/compatProviders.js).
export const AI_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', hint: 'Tem plano gratuito generoso. Chave em aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI ChatGPT', model: 'gpt-4o-mini', hint: 'Chave em platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic Claude', model: 'claude-haiku-4-5', hint: 'Ótimo em seguir instruções. Chave em console.anthropic.com' },
  { id: 'groq', label: 'Groq (Llama — muito rápido)', model: 'llama-3.3-70b-versatile', hint: 'Respostas quase instantâneas e barato. Chave em console.groq.com' },
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', hint: 'Muito econômico. Chave em platform.deepseek.com' },
  { id: 'mistral', label: 'Mistral AI', model: 'mistral-small-latest', hint: 'Empresa europeia. Chave em console.mistral.ai' },
  { id: 'xai', label: 'xAI Grok', model: 'grok-3-mini', hint: 'Chave em console.x.ai' },
  { id: 'openrouter', label: 'OpenRouter (centenas de modelos)', model: 'openai/gpt-4o-mini', hint: 'Uma chave para vários modelos. Chave em openrouter.ai/keys' },
  { id: 'together', label: 'Together AI', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', hint: 'Modelos abertos. Chave em api.together.xyz' },
  { id: 'custom', label: 'Outro (compatível com OpenAI)', model: '', needsBaseUrl: true, hint: 'Informe o endereço da API (termina em /v1) e o nome do modelo.' }
];

export function aiProviderLabel(id) {
  return AI_PROVIDERS.find((p) => p.id === id)?.label || id;
}
