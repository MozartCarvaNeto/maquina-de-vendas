// backend/src/controllers/settingsController.js
const prisma = require('../config/db');
const { encrypt } = require('../services/crypto/settingsCrypto');
const { PROVIDER_REGISTRY, getActiveTelephonyProvider, isTelephonyConfiguredViaEnv } = require('../services/telephony/providerFactory');
const { EMAIL_PROVIDER_REGISTRY, getEmailProvider } = require('../services/email/emailProviderFactory');

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
      select: { category: true, provider: true, key: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' }
    });

    const grouped = {};
    for (const setting of settings) {
      const groupKey = `${setting.category}:${setting.provider}`;
      if (!grouped[groupKey]) {
        grouped[groupKey] = { category: setting.category, provider: setting.provider, keys: [], updatedAt: setting.updatedAt };
      }
      grouped[groupKey].keys.push(setting.key);
      if (setting.updatedAt > grouped[groupKey].updatedAt) grouped[groupKey].updatedAt = setting.updatedAt;
    }

    res.json({ settings: Object.values(grouped) });
  } catch (error) {
    next(error);
  }
};

exports.saveTelephonySettings = async (req, res, next) => {
  try {
    const { provider, credentials } = req.body;

    if (!provider || !PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de telefonia inválido' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }

    await prisma.setting.updateMany({ where: { userId: req.userId, category: 'telephony' }, data: { isActive: false } });

    const upserts = Object.entries(credentials).map(([key, value]) =>
      prisma.setting.upsert({
        where: { userId_category_provider_key: { userId: req.userId, category: 'telephony', provider, key } },
        update: { value: encrypt(String(value)), isActive: true },
        create: { userId: req.userId, category: 'telephony', provider, key, value: encrypt(String(value)), isActive: true }
      })
    );
    await Promise.all(upserts);

    const instance = await getActiveTelephonyProvider(req.userId);
    const validation = await instance.validateCredentials();

    if (!validation.valid) {
      return res.status(400).json({ error: 'Credenciais salvas, mas a validação falhou', details: validation.error });
    }

    res.json({ success: true, message: 'Integração de telefonia configurada com sucesso' });
  } catch (error) {
    next(error);
  }
};

exports.saveEmailSettings = async (req, res, next) => {
  try {
    const { provider, credentials } = req.body;

    if (!provider || !EMAIL_PROVIDER_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Provedor de e-mail inválido' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }

    if (provider === 'resend') {
      if (!credentials.apiKey || !credentials.fromEmail) {
        return res.status(400).json({ error: 'apiKey e fromEmail são obrigatórios para o Resend' });
      }
    }
    if (provider === 'smtp') {
      const requiredFields = ['host', 'port', 'user', 'pass', 'fromEmail'];
      const missing = requiredFields.filter((key) => !credentials[key]);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Campos obrigatórios ausentes para SMTP: ${missing.join(', ')}` });
      }
    }
    if (provider === 'native') {
      // Nome/e-mail do remetente e domínio agora vivem em EmailDomain (ver
      // Configurações > E-mail > E-mail Nativo), não aqui — aqui só guardamos
      // qual provedor está ativo. Se nada foi enviado, grava um marcador para
      // a linha não ficar vazia (o factory usa isto só para saber que
      // "native" é o provedor escolhido, e busca o resto no EmailDomain).
      if (Object.keys(credentials).length === 0) credentials.ativo = 'true';
    }

    await prisma.setting.updateMany({ where: { userId: req.userId, category: 'email' }, data: { isActive: false } });

    const upserts = Object.entries(credentials).map(([key, value]) =>
      prisma.setting.upsert({
        where: { userId_category_provider_key: { userId: req.userId, category: 'email', provider, key } },
        update: { value: encrypt(String(value)), isActive: true },
        create: { userId: req.userId, category: 'email', provider, key, value: encrypt(String(value)), isActive: true }
      })
    );
    await Promise.all(upserts);

    const instance = await getEmailProvider(req.userId);
    const validation = await instance.validateCredentials();

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Credenciais salvas, mas a validação falhou. Verifique host/porta/usuário/senha.',
        details: validation.error
      });
    }

    res.json({ success: true, message: 'Integração de e-mail configurada com sucesso' });
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