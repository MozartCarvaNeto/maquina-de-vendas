// backend/src/controllers/settingsController.js
const prisma = require('../config/db');
const { decrypt } = require('../services/crypto/settingsCrypto');
const { isSecretKey, maskSecret, mergeCredentials, persistCredentials } = require('../services/settingsHelpers');
const { PROVIDER_REGISTRY, AI_TELEPHONY_REGISTRY, getActiveTelephonyProvider, isTelephonyConfiguredViaEnv } = require('../services/telephony/providerFactory');
const { EMAIL_PROVIDER_REGISTRY, getEmailProvider } = require('../services/email/emailProviderFactory');
const { getActiveDomainForSending } = require('../services/email/emailDomainService');
const TwilioEmailProvider = require('../services/email/TwilioEmailProvider');
const { getTwilioCredentials } = require('../services/twilioCredentials');
const { getSmsProvider, getSmsSender } = require('../services/sms/smsProviderFactory');
const { toE164BR } = require('../utils/phone');

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
    res.json({ telephonyConfiguredViaEnv: await isTelephonyConfiguredViaEnv(req.userId) });
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

/**
 * Operadora das ligações do Agente de IA (alternativa à Twilio). Fica numa categoria própria
 * ("ai_telephony"): o discador manual com vendedor continua usando a telefonia de sempre.
 * Escolher "twilio" (ou apagar esta configuração) volta ao comportamento original.
 */
exports.saveAiTelephonySettings = async (req, res, next) => {
  try {
    const { provider, credentials, force } = req.body;
    if (!provider || !AI_TELEPHONY_REGISTRY[provider]) {
      return res.status(400).json({ error: 'Operadora inválida.' });
    }

    if (provider === 'twilio') {
      await persistCredentials(req.userId, 'ai_telephony', 'twilio', { ativo: 'true' }, [], { exclusive: true });
      return res.json({ success: true, validated: true, message: 'As ligações da IA vão usar a Twilio (configuração padrão).' });
    }

    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Credenciais não informadas' });
    }
    const { merged, toDelete } = await mergeCredentials(req.userId, 'ai_telephony', provider, credentials);

    if (provider === 'telnyx' && (!merged.apiKey || !merged.applicationSid)) {
      return res.status(400).json({ error: 'Informe a API Key da Telnyx e o ID do TeXML Application.' });
    }
    if (provider === 'jambonz' && (!merged.apiKey || !merged.accountSid)) {
      return res.status(400).json({ error: 'Informe o token da API e o Account SID do Jambonz.' });
    }

    const validation = await validateWithRegistry(AI_TELEPHONY_REGISTRY, provider, merged);
    if (!validation.valid && !force) {
      return res.status(422).json({
        error: 'A operadora recusou essas credenciais — nada foi alterado.',
        details: validation.error,
        canForce: true
      });
    }

    await persistCredentials(req.userId, 'ai_telephony', provider, merged, toDelete, { exclusive: true });
    res.json({
      success: true,
      validated: validation.valid,
      message: validation.valid
        ? 'Operadora das ligações da IA configurada. Faça uma ligação de teste para validar.'
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
    if (provider === 'sendgrid') {
      if (!merged.apiKey || !merged.fromEmail) {
        return res.status(400).json({ error: 'Informe a API Key do SendGrid e o e-mail remetente (já verificado no SendGrid).' });
      }
      if (!/^SG\./.test(merged.apiKey)) {
        return res.status(400).json({ error: 'A chave do SendGrid começa com "SG.". O Account SID/Auth Token da Twilio não envia e-mails.' });
      }
    }
    if (provider === 'twilio_email') {
      if (!merged.fromEmail) {
        return res.status(400).json({ error: 'Informe o e-mail remetente (precisa estar verificado na Twilio).' });
      }
      const twilioCreds = await getTwilioCredentials(req.userId);
      if (!twilioCreds) {
        return res.status(400).json({ error: 'Cadastre antes as chaves da Twilio (Account SID e Auth Token) em Configurações > Telefonia.' });
      }
      const validation = await new TwilioEmailProvider({ ...merged, ...twilioCreds }).validateCredentials();
      if (!validation.valid && !force) {
        return res.status(422).json({ error: 'A Twilio recusou as chaves para e-mail — nada foi alterado.', details: validation.error, canForce: true });
      }
      await persistCredentials(req.userId, 'email', provider, merged, toDelete, { exclusive: true });
      return res.json({
        success: true,
        validated: validation.valid,
        message: 'E-mail da Twilio configurado. Use "Enviar e-mail de teste" para confirmar o remetente.',
        warning: validation.valid ? undefined : validation.error
      });
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

/** Remetente padrão de SMS (número da Twilio com SMS, ID alfanumérico ou Messaging Service MG…). */
exports.saveSmsSettings = async (req, res, next) => {
  try {
    const sender = String((req.body || {}).sender || '').trim();
    if (!sender) {
      // Campo vazio = remove o remetente salvo (volta aos números de discagem).
      await prisma.setting.deleteMany({ where: { userId: req.userId, category: 'sms' } });
      return res.json({ success: true, message: 'Remetente de SMS removido.' });
    }
    if (!/^(\+\d{8,15}|MG[0-9a-fA-F]{32}|[A-Za-z0-9 ]{3,11})$/.test(sender)) {
      return res.status(400).json({ error: 'Remetente inválido. Use o número com +país (ex.: +12025550123), o ID do Messaging Service (MG…) ou um nome de 3 a 11 letras/números.' });
    }
    const { merged, toDelete } = await mergeCredentials(req.userId, 'sms', 'twilio', { sender });
    await persistCredentials(req.userId, 'sms', 'twilio', merged, toDelete, { exclusive: true });
    res.json({ success: true, message: 'Remetente de SMS salvo.' });
  } catch (error) {
    next(error);
  }
};

/** Envia um SMS de teste de verdade e devolve o erro da Twilio já traduzido (para diagnosticar). */
exports.testSms = async (req, res, next) => {
  try {
    const to = toE164BR((req.body || {}).to);
    if (!to) return res.status(400).json({ error: 'Informe o celular de destino com DDD.' });
    const provider = await getSmsProvider(req.userId);
    let from = provider.sender;
    if (!from) {
      const number = await prisma.callerNumber.findFirst({ where: { userId: req.userId, isActive: true } });
      from = number?.phoneNumber || null;
    }
    await provider.sendSms({ to, from, body: 'Teste de SMS do Turbo Prospect: se você recebeu, está tudo certo!' });
    res.json({ success: true, message: `SMS de teste enviado para ${to}.`, from });
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
};

/** Envia um e-mail de teste pelo provedor de e-mail ativo. */
exports.testEmail = async (req, res, next) => {
  try {
    const to = String((req.body || {}).to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Informe um e-mail de destino válido.' });
    const provider = await getEmailProvider(req.userId);
    await provider.sendEmail({ to, subject: 'Teste do Turbo Prospect', html: '<p>Se você recebeu este e-mail, o envio está funcionando.</p>' });
    res.json({ success: true, message: `E-mail de teste enviado para ${to}.` });
  } catch (error) {
    res.status(422).json({ error: error.message });
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