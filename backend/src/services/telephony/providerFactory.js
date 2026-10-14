// backend/src/services/telephony/providerFactory.js
const TwilioProvider = require('./TwilioProvider');
const TelnyxProvider = require('./TelnyxProvider');
const JambonzProvider = require('./JambonzProvider');
const prisma = require('../../config/db');
const env = require('../../config/env');
const { decrypt } = require('../crypto/settingsCrypto');

/**
 * Registro de provedores disponíveis. Para adicionar um novo provedor
 * (ex: Zenvia, Vonage), basta criar a classe implementando
 * ITelephonyProvider e registrar aqui.
 */
const PROVIDER_REGISTRY = {
  twilio: TwilioProvider
};

/**
 * Monta uma instância do provedor de telefonia ATIVO.
 * Prioridade:
 * 1) Credenciais salvas no banco (configuradas pela tela Configurações).
 * 2) Variáveis de ambiente do backend (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN
 *    no .env) — permite usar o Twilio sem nenhuma configuração manual.
 */
async function getActiveTelephonyProvider(userId) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'telephony', isActive: true }
  });

  if (settings.length > 0) {
    const providerName = settings[0].provider;
    const ProviderClass = PROVIDER_REGISTRY[providerName];

    if (!ProviderClass) {
      const err = new Error(`Provedor de telefonia "${providerName}" não suportado.`);
      err.status = 400;
      throw err;
    }

    const credentials = {};
    for (const setting of settings) {
      credentials[setting.key] = decrypt(setting.value);
    }

    return new ProviderClass(credentials);
  }

  if (env.twilioAccountSid && env.twilioAuthToken) {
    return new TwilioProvider({ accountSid: env.twilioAccountSid, authToken: env.twilioAuthToken });
  }

  const err = new Error(
    'Nenhum provedor de telefonia configurado. Preencha TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN no arquivo .env do backend, ou configure manualmente em Configurações > Telefonia.'
  );
  err.status = 400;
  throw err;
}

/** Usado pela tela de Configurações, para mostrar um aviso "já configurado via .env". */
function isTelephonyConfiguredViaEnv() {
  return !!(env.twilioAccountSid && env.twilioAuthToken);
}

/**
 * Operadoras alternativas SÓ para as ligações do Agente de IA (categoria "ai_telephony").
 * O discador manual (vendedor) continua usando getActiveTelephonyProvider (Twilio).
 *  - twilio:  usa a mesma Twilio já configurada (padrão — nada muda se você não escolher outra)
 *  - telnyx:  Telnyx (TeXML)
 *  - jambonz: Jambonz + seu tronco SIP nacional
 */
const AI_TELEPHONY_REGISTRY = {
  twilio: TwilioProvider,
  telnyx: TelnyxProvider,
  jambonz: JambonzProvider
};

async function getAiTelephonyProvider(userId) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'ai_telephony', isActive: true }
  });
  const chosen = settings[0]?.provider;

  // Sem escolha (ou escolheu "twilio"): comportamento de sempre.
  if (!chosen || chosen === 'twilio') return getActiveTelephonyProvider(userId);

  const ProviderClass = AI_TELEPHONY_REGISTRY[chosen];
  if (!ProviderClass) {
    const err = new Error(`Operadora da IA "${chosen}" não suportada.`);
    err.status = 400;
    throw err;
  }
  const credentials = {};
  for (const setting of settings) credentials[setting.key] = decrypt(setting.value);
  return new ProviderClass(credentials);
}

module.exports = {
  getActiveTelephonyProvider,
  getAiTelephonyProvider,
  isTelephonyConfiguredViaEnv,
  PROVIDER_REGISTRY,
  AI_TELEPHONY_REGISTRY
};