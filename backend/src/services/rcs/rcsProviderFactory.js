// backend/src/services/rcs/rcsProviderFactory.js
const prisma = require('../../config/db');
const { decrypt } = require('../crypto/settingsCrypto');
const { getTwilioCredentials } = require('../twilioCredentials');
const { TwilioRcsProvider, CustomHttpRcsProvider } = require('./rcsProviders');

/** Lê Configurações > RCS (category "rcs"): provider "twilio" ou "custom". */
async function readRcsSettings(userId) {
  const rows = await prisma.setting.findMany({ where: { userId, category: 'rcs', isActive: true } });
  if (!rows.length) return null;
  const values = {};
  for (const row of rows) {
    try {
      values[row.key] = decrypt(row.value);
    } catch (_) {
      /* gravada com outra chave de criptografia */
    }
  }
  return { provider: rows[0].provider, values };
}

async function getRcsProvider(userId) {
  const settings = await readRcsSettings(userId);
  if (!settings) {
    const err = new Error('Configure o RCS em Configurações > RCS (Twilio ou outro provedor) antes de disparar.');
    err.status = 400;
    err.configProblem = true;
    throw err;
  }
  const v = settings.values;
  if (settings.provider === 'twilio') {
    const credentials = await getTwilioCredentials(userId);
    if (!credentials) {
      const err = new Error('Configure as chaves da Twilio (Account SID e Auth Token) em Configurações > Telefonia para usar o RCS da Twilio.');
      err.status = 400;
      err.configProblem = true;
      throw err;
    }
    return new TwilioRcsProvider(credentials, {
      sender: v.sender,
      fallbackFrom: v.fallbackFrom,
      disableFallback: v.disableFallback === 'true'
    });
  }
  if (settings.provider === 'custom') {
    if (!v.url || !v.bodyTemplate) {
      const err = new Error('Configurações > RCS: informe o endereço (URL) e o modelo de corpo do provedor.');
      err.configProblem = true;
      throw err;
    }
    return new CustomHttpRcsProvider({
      url: v.url,
      authHeader: v.authHeader,
      apiKey: v.apiKey,
      sender: v.sender,
      bodyTemplate: v.bodyTemplate
    });
  }
  const err = new Error('Provedor de RCS desconhecido em Configurações > RCS.');
  err.configProblem = true;
  throw err;
}

module.exports = { getRcsProvider, readRcsSettings };
