// backend/src/services/twilioCredentials.js
//
// De onde vêm as chaves da Twilio (Account SID + Auth Token) usadas por ligação, SMS e e-mail:
//  1) as que a PRÓPRIA conta salvou em Configurações > Telefonia;
//  2) as chaves globais da plataforma (.env: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) — essas só valem para a
//     conta do ADMINISTRADOR da plataforma. Clientes nunca usam (nem veem) as chaves do administrador.
const prisma = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('./crypto/settingsCrypto');
const { isPlatformAdminAccount } = require('./accessService');

async function getTwilioCredentials(userId) {
  const rows = await prisma.setting.findMany({ where: { userId, category: 'telephony', isActive: true } });
  if (rows.length > 0 && rows[0].provider === 'twilio') {
    const creds = {};
    for (const row of rows) creds[row.key] = decrypt(row.value);
    if (creds.accountSid && creds.authToken) return { accountSid: creds.accountSid, authToken: creds.authToken, source: 'conta' };
  }
  if (env.twilioAccountSid && env.twilioAuthToken && (await isPlatformAdminAccount(userId))) {
    return { accountSid: env.twilioAccountSid, authToken: env.twilioAuthToken, source: 'plataforma' };
  }
  return null;
}

module.exports = { getTwilioCredentials };
