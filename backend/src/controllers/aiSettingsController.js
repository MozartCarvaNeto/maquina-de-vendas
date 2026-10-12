// backend/src/controllers/aiSettingsController.js
const prisma = require('../config/db');
const { mergeCredentials, persistCredentials, readStoredCredentials, describeStored } = require('../services/settingsHelpers');
const {
  AI_PROVIDER_REGISTRY,
  listConfiguredAiProviders
} = require('../services/ai/aiProviderFactory');

exports.listAvailableProviders = async (req, res, next) => {
  try {
    res.json({ providers: Object.keys(AI_PROVIDER_REGISTRY), meta: require('../services/ai/providerMeta') });
  } catch (error) {
    next(error);
  }
};

/**
 * Qualquer membro da conta enxerga QUAIS provedores existem (a tela de Campanhas precisa disso para
 * montar o seletor). Só dono/administrador recebe também os detalhes (modelo, endereço, final da chave).
 */
exports.listMyProviders = async (req, res, next) => {
  try {
    const providers = await listConfiguredAiProviders(req.userId);
    const payload = { providers };

    if (['owner', 'admin'].includes(req.memberRole)) {
      payload.details = {};
      for (const provider of providers) {
        const stored = await readStoredCredentials(req.userId, 'ai', provider);
        payload.details[provider] = describeStored(stored);
      }
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
};

/**
 * Salva credenciais de um provedor de IA SEM desativar os demais —
 * diferente da telefonia, aqui o usuário pode ter Gemini e OpenAI
 * configurados ao mesmo tempo, e cada campanha escolhe qual usar.
 *
 * Fluxo: (1) limpa espaços da chave, (2) testa a chave SEM gravar, (3) só grava se o teste passar
 * (ou se o usuário escolheu "salvar mesmo assim"). Uma chave que falha no teste nunca apaga nem
 * sobrescreve a que já estava funcionando.
 */
exports.saveProvider = async (req, res, next) => {
  try {
    const { provider, credentials, force } = req.body;

    if (!provider || !AI_PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de IA inválido' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }

    const { merged, toDelete } = await mergeCredentials(req.userId, 'ai', provider, credentials);
    if (!merged.apiKey) {
      return res.status(400).json({ error: 'Campo "apiKey" é obrigatório em credentials' });
    }

    if (merged.baseUrl) {
      try {
        require('../services/ai/voice/catalogService').assertSafeUrl(merged.baseUrl);
      } catch (e) {
        return res.status(400).json({ error: 'Endereço da API inválido ou interno. Use algo como https://meu-servidor.com/v1' });
      }
    }

    let validation;
    try {
      const ProviderClass = AI_PROVIDER_REGISTRY[provider];
      validation = await new ProviderClass(merged).validateCredentials();
    } catch (error) {
      validation = { valid: false, error: error.message };
    }

    if (!validation.valid && !force) {
      return res.status(422).json({
        error: 'O teste da chave falhou — nada foi alterado. Confira a chave, o modelo e se há saldo/cota na conta.',
        details: validation.error,
        canForce: true
      });
    }

    await persistCredentials(req.userId, 'ai', provider, merged, toDelete, { exclusive: false });

    res.json({
      success: true,
      validated: validation.valid,
      message: validation.valid
        ? `Provedor de IA "${provider}" configurado com sucesso`
        : `Provedor de IA "${provider}" salvo SEM validação (você escolheu salvar mesmo assim)`,
      warning: validation.valid ? undefined : validation.error
    });
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