// backend/src/services/sms/smsProviderFactory.js
const prisma = require('../../config/db');
const env = require('../../config/env');
const { decrypt } = require('../crypto/settingsCrypto');
const TwilioSmsProvider = require('./TwilioSmsProvider');
const { getTwilioCredentials } = require('../twilioCredentials');
const { isPlatformAdminAccount } = require('../accessService');

/** Remetente de SMS: o salvo em Configurações > SMS; senão (só administrador) o do .env (TWILIO_SMS_FROM). */
async function getSmsSender(userId) {
  const rows = await prisma.setting.findMany({ where: { userId, category: 'sms', isActive: true } });
  const row = rows.find((r) => r.key === 'sender');
  if (row) return decrypt(row.value);
  if (env.twilioSmsFrom && (await isPlatformAdminAccount(userId))) return env.twilioSmsFrom;
  return null;
}

/**
 * SMS pela Twilio, com as mesmas chaves da Telefonia (da conta ou, para o administrador, as da plataforma no .env).
 * `provider.sender` traz o remetente padrão (pode ser null: nesse caso quem chama escolhe um número de discagem).
 */
async function getSmsProvider(userId) {
  const credentials = await getTwilioCredentials(userId);
  if (!credentials) {
    const err = new Error('Configure as chaves da Twilio (Account SID e Auth Token) em Configurações > Telefonia para enviar SMS.');
    err.status = 400;
    err.configProblem = true;
    throw err;
  }
  return new TwilioSmsProvider(credentials, { sender: await getSmsSender(userId) });
}

module.exports = { getSmsProvider, getSmsSender };
