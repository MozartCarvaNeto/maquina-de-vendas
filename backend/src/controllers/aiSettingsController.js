// backend/src/controllers/aiSettingsController.js
const prisma = require('../config/db');
const { encrypt } = require('../services/crypto/settingsCrypto');
const {
  AI_PROVIDER_REGISTRY,
  getActiveAiProvider,
  listConfiguredAiProviders
} = require('../services/ai/aiProviderFactory');

exports.listAvailableProviders = async (req, res, next) => {
  try {
    res.json({ providers: Object.keys(AI_PROVIDER_REGISTRY), meta: require('../services/ai/providerMeta') });
  } catch (error) {
    next(error);
  }
};

exports.listMyProviders = async (req, res, next) => {
  try {
    const providers = await listConfiguredAiProviders(req.userId);
    res.json({ providers });
  } catch (error) {
    next(error);
  }
};

/**
 * Salva credenciais de um provedor de IA SEM desativar os demais —
 * diferente da telefonia, aqui o usuário pode ter Gemini e OpenAI
 * configurados ao mesmo tempo, e cada campanha escolhe qual usar.
 */
exports.saveProvider = async (req, res, next) => {
  try {
    const { provider, credentials } = req.body;

    if (!provider || !AI_PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de IA inválido' });
    }
    if (!credentials || typeof credentials !== 'object' || !credentials.apiKey) {
      return res.status(400).json({ error: 'Campo "apiKey" é obrigatório em credentials' });
    }

    const alreadyConfigured = (await prisma.setting.count({ where: { userId: req.userId, category: 'ai', provider } })) > 0;
    if (credentials.baseUrl) {
      try {
        require('../services/ai/voice/catalogService').assertSafeUrl(credentials.baseUrl);
      } catch (e) {
        return res.status(400).json({ error: 'Endereço da API inválido ou interno. Use algo como https://meu-servidor.com/v1' });
      }
    }

    const upserts = Object.entries(credentials).map(([key, value]) =>
      prisma.setting.upsert({
        where: {
          userId_category_provider_key: {
            userId: req.userId,
            category: 'ai',
            provider,
            key
          }
        },
        update: { value: encrypt(String(value)), isActive: true },
        create: {
          userId: req.userId,
          category: 'ai',
          provider,
          key,
          value: encrypt(String(value)),
          isActive: true
        }
      })
    );

    await Promise.all(upserts);

    const instance = await getActiveAiProvider(req.userId, provider);
    const validation = await instance.validateCredentials();

    if (!validation.valid) {
      // Chave nova que não funcionou: não deixa lixo salvo (o robô tentaria usá-la).
      if (!alreadyConfigured) {
        await prisma.setting.deleteMany({ where: { userId: req.userId, category: 'ai', provider } });
      }
      return res.status(400).json({
        error: 'Credenciais salvas, mas a validação falhou. Verifique a chave de API.',
        details: validation.error
      });
    }

    res.json({ success: true, message: `Provedor de IA "${provider}" configurado com sucesso` });
  } catch (error) {
    next(error);
  }
};

exports.deleteProvider = async (req, res, next) => {
  try {
    const { provider } = req.params;
    await prisma.setting.deleteMany({
      where: { userId: req.userId, category: 'ai', provider }
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};