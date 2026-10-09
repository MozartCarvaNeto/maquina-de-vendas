// backend/src/services/ai/aiProviderFactory.js
const prisma = require('../../config/db');
const { decrypt } = require('../crypto/settingsCrypto');
const GeminiProvider = require('./GeminiProvider');
const OpenAiProvider = require('./OpenAiProvider');

/**
 * Registro de provedores de IA disponíveis. Para adicionar um novo
 * (ex: Claude, Llama via Groq, etc.), basta:
 * 1. Criar a classe em /ai implementando IAiProvider
 * 2. Registrar aqui nesse mapa
 * Nenhum outro arquivo do sistema precisa mudar.
 */
const AI_PROVIDER_REGISTRY = {
  gemini: GeminiProvider,
  openai: OpenAiProvider
};

/**
 * Retorna a instância do provedor de IA a ser usado para uma campanha.
 * Se a campanha tiver "aiProviderOverride" definido, usa esse provedor
 * específico. Caso contrário, usa o primeiro provedor de IA ativo
 * configurado na conta do usuário.
 * Retorna null se nenhum provedor de IA estiver configurado (atendimento
 * fica então 100% manual, sem bot automático).
 */
async function getActiveAiProvider(userId, overrideProviderName) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'ai', isActive: true }
  });

  if (settings.length === 0) return null;

  const providerName = overrideProviderName || settings[0].provider;
  const providerSettings = settings.filter((s) => s.provider === providerName);

  if (providerSettings.length === 0) return null;

  const ProviderClass = AI_PROVIDER_REGISTRY[providerName];
  if (!ProviderClass) return null;

  const credentials = {};
  for (const setting of providerSettings) {
    credentials[setting.key] = decrypt(setting.value);
  }

  return new ProviderClass(credentials);
}

/**
 * Lista quais provedores de IA o usuário já configurou (sem expor segredos).
 * Usado pelo frontend para popular o dropdown de "IA da campanha".
 */
async function listConfiguredAiProviders(userId) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'ai', isActive: true },
    select: { provider: true }
  });
  return [...new Set(settings.map((s) => s.provider))];
}

module.exports = { getActiveAiProvider, listConfiguredAiProviders, AI_PROVIDER_REGISTRY };