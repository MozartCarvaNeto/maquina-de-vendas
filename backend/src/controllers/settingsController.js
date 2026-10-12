// backend/src/controllers/settingsController.js
const prisma = require('../config/db');
const { decrypt } = require('../services/crypto/settingsCrypto');
const { isSecretKey, maskSecret, mergeCredentials, persistCredentials } = require('../services/settingsHelpers');
const { PROVIDER_REGISTRY, getActiveTelephonyProvider, isTelephonyConfiguredViaEnv } = require('../services/telephony/providerFactory');
const { EMAIL_PROVIDER_REGISTRY, getEmailProvider } = require('../services/email/emailProviderFactory');
const { getActiveDomainForSending } = require('../services/email/emailDomainService');

exports.listAvailableProviders = async (req, res, next) => {
  try {
    res.json({
      telephony: Object.keys(PROVIDER_REGISTRY),
      email: Object.keys(EMAIL_PROVIDER_REGISTRY)
    });
  } catch (error) {
    next(error);
  }
};

/** Diz ao frontend se o Twilio já está funcionando via .env, sem precisar configurar pela tela. */
exports.getEnvStatus = async (req, res, next) => {
  try {
    res.json({ telephonyConfiguredViaEnv: isTelephonyConfiguredViaEnv() });
  } catch (error) {
    next(error);
  }
};

exports.listMySettings = async (req, res, next) => {
  try {
    const settings = await prisma.setting.findMany({
      where: { userId: req.userId, isActive: true },
      orderBy: { updatedAt: 'desc' }
    });

    // Devolve, por integração, os campos comuns (host, e-mail remetente, modelo...) e só uma
    // dica mascarada dos segredos (••••abcd). Assim a tela consegue mostrar o que já está salvo
    // depois que o usuário sai e volta, sem nunca expor a chave inteira.
    const grouped = {};
    for (const setting of settings) {
      const groupKey = `${setting.category}:${setting.provider}`;
      if (!grouped[groupKey]) {
        grouped[groupKey] = { category: setting.category, provider: setting.provider, keys: [], values: {}, hints: {}, updatedAt: setting.updatedAt };
      }
      const group = grouped[groupKey];
      group.keys.push(setting.key);
      let plain = null;
      try {
        plain = decrypt(setting.value);
      } catch (_) {
        group.unreadable = true; // gravada com outra SETTINGS_ENCRYPTION_KEY: precisa ser cadastrada de novo
      }
      if (plain !== null) {
        if (isSecretKey(setting.key)) group.hints[setting.key] = maskSecret(plain);
        else group.values[setting.key] = plain;
      }
      if (setting.updatedAt > group.updatedAt) group.updatedAt = setting.updatedAt;
    }

    res.json({ settings: Object.values(grouped) });
  } catch (error) {
    next(error);
  }
};

/**
 * Testa as credenciais ANTES de gravar. Se o teste falhar, nada é alterado (a configuração que já
 * funcionava continua valendo) e o frontend recebe 422 + canForce, podendo oferecer "Salvar mesmo assim".
 */
async function validateWithRegistry(Registry, provider, credentials) {
  try {
    const instance = new Registry[provider](credentials);
    return await instance.validateCredentials();
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

exports.saveTelephonySettings = async (req, res, next) => {
  try {
    const { provider, credentials, force } = req.body;

    if (!provider || !PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de telefonia inválido' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }

    const { merged, toDelete } = await mergeCredentials(req.userId, 'telephony', provider, credentials);
    if (!merged.accountSid || !merged.authToken) {
      return res.status(400).json({ error: 'Informe o Account SID e o Auth Token.' });
    }

    const validation = await validateWithRegistry(PROVIDER_REGISTRY, provider, merged);
    if (!validation.valid && !force) {
      return res.status(422).json({
        error: 'A telefonia recusou essas credenciais — nada foi alterado.',
        details: validation.error,
        canForce: true
      });
    }

    await persistCredentials(req.userId, 'telephony', provider, merged, toDelete, { exclusive: true });

    res.json({
      success: true,
      validated: validation.valid,
      message: validation.valid
        ? 'Integração de telefonia configurada com sucesso'
        : 'Credenciais salvas SEM validação (você escolheu salvar mesmo assim)',
      warning: validation.valid ? undefined : validation.error
    });
  } catch (error) {
    next(error);
  }
};

exports.saveEmailSettings = async (req, res, next) => {
  try {
    const { provider, credentials: incoming, force } = req.body;

    if (!provider || !EMAIL_PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de e-mail inválido' });
    }
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }

    const { merged, toDelete } = await mergeCredentials(req.userId, 'email', provider, incoming);

    if (provider === 'resend') {
      if (!merged.apiKey || !merged.fromEmail) {
        return res.status(400).json({ error: 'apiKey e fromEmail são obrigatórios para o Resend' });
      }
    }
    if (provider === 'smtp') {
      const requiredFields = ['host', 'port', 'user', 'pass', 'fromEmail'];
      const missing = requiredFields.filter((key) => !merged[key]);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Campos obrigatórios ausentes para SMTP: ${missing.join(', ')}` });
      }
    }

    if (provider === 'native') {
      // Remetente e domínio vivem em EmailDomain; aqui só se marca o motor nativo como ativo.
      const domainRow = await getActiveDomainForSending(req.userId, {});
      if (!domainRow) {
        return res.status(400).json({ error: 'Cadastre pelo menos um domínio antes de ativar o E-mail Nativo.' });
      }
      if (Object.keys(merged).length === 0) merged.ativo = 'true';
      await persistCredentials(req.userId, 'email', provider, merged, toDelete, { exclusive: true });

      let warning;
      try {
        const instance = await getEmailProvider(req.userId);
        const validation = await instance.validateCredentials();
        if (!validation.valid) warning = validation.error;
      } catch (e) {
        warning = e.message;
      }
      return res.json({ success: true, message: 'E-mail Nativo ativado', warning });
    }

    const validation = await validateWithRegistry(EMAIL_PROVIDER_REGISTRY, provider, merged);
    if (!validation.valid && !force) {
      return res.status(422).json({
        error: 'O servidor de e-mail recusou essas credenciais — nada foi alterado. Verifique host/porta/usuário/senha.',
        details: validation.error,
        canForce: true
      });
    }

    await persistCredentials(req.userId, 'email', provider, merged, toDelete, { exclusive: true });

    res.json({
      success: true,
      validated: validation.valid,
      message: validation.valid
        ? 'Integração de e-mail configurada com sucesso'
        : 'Credenciais salvas SEM validação (você escolheu salvar mesmo assim)',
      warning: validation.valid ? undefined : validation.error
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteSetting = async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.setting.deleteMany({ where: { id, userId: req.userId } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.deleteProviderSettings = async (req, res, next) => {
  try {
    const { category, provider } = req.params;
    const result = await prisma.setting.deleteMany({ where: { userId: req.userId, category, provider } });
    if (result.count === 0) {
      return res.status(404).json({ error: 'Nenhuma configuração encontrada para remover' });
    }
    res.json({ success: true, removed: result.count });
  } catch (error) {
    next(error);
  }
};