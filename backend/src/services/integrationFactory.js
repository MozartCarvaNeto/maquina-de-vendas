// backend/src/services/integrationFactory.js
const prisma = require('../config/db');
const { decrypt, encrypt } = require('./crypto/settingsCrypto');

/**
 * Fábrica genérica de credenciais, usada hoje pela categoria "dialer"
 * (configurações do discador). WhatsApp não usa mais isto — a conexão
 * é nativa via whatsapp-web.js, sem credenciais externas.
 */
async function getCredentials(userId, category) {
  const settings = await prisma.setting.findMany({
    where: { userId, category, isActive: true }
  });

  if (settings.length === 0) return null;

  const credentials = {};
  for (const setting of settings) {
    credentials[setting.key] = decrypt(setting.value);
  }
  return credentials;
}

async function saveCredentials(userId, category, provider, credentials) {
  await prisma.setting.updateMany({
    where: { userId, category },
    data: { isActive: false }
  });

  const upserts = Object.entries(credentials).map(([key, value]) =>
    prisma.setting.upsert({
      where: { userId_category_provider_key: { userId, category, provider, key } },
      update: { value: encrypt(String(value)), isActive: true },
      create: { userId, category, provider, key, value: encrypt(String(value)), isActive: true }
    })
  );
  await Promise.all(upserts);
}

module.exports = { getCredentials, saveCredentials };