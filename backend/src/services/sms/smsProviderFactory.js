// backend/src/services/sms/smsProviderFactory.js
const prisma = require('../../config/db');
const { decrypt } = require('../crypto/settingsCrypto');
const TwilioSmsProvider = require('./TwilioSmsProvider');

/**
 * Busca a credencial de telefonia já cadastrada (Fase 1) e monta um
 * provedor de SMS em cima dela. Se você troca de operadora de telefonia,
 * o SMS acompanha automaticamente.
 */
async function getSmsProvider(userId) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'telephony', isActive: true }
  });

  if (settings.length === 0) {
    const err = new Error('Configure a telefonia (Twilio) antes de enviar SMS. Acesse Configurações > Telefonia.');
    err.status = 400;
    throw err;
  }

  const providerName = settings[0].provider;
  if (providerName !== 'twilio') {
    const err = new Error(`Envio de SMS via "${providerName}" ainda não suportado.`);
    err.status = 400;
    throw err;
  }

  const credentials = {};
  for (const setting of settings) {
    credentials[setting.key] = decrypt(setting.value);
  }

  return new TwilioSmsProvider(credentials);
}

module.exports = { getSmsProvider };