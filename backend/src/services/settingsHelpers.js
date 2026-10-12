// backend/src/services/settingsHelpers.js
//
// Funções compartilhadas pelas telas de Configurações (telefonia, e-mail, IA).
// Objetivos:
//  - limpar espaços/quebras de linha colados junto com a chave;
//  - nunca perder uma chave já salva só porque o campo veio em branco;
//  - gravar tudo de uma vez (transação), sem deixar a conta "pela metade";
//  - devolver ao frontend uma dica mascarada (••••abcd) das chaves secretas,
//    para a tela mostrar que a chave continua salva depois de sair e voltar.
const prisma = require('../config/db');
const { encrypt, decrypt } = require('./crypto/settingsCrypto');

// Campos que são segredos: nunca voltam inteiros para o navegador.
const SECRET_KEYS = new Set(['apiKey', 'authToken', 'pass', 'password', 'token', 'secret', 'accessToken']);

function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  return v.length >= 8 ? `••••${v.slice(-4)}` : '••••';
}

function safeDecrypt(payload) {
  try {
    return decrypt(payload);
  } catch (_) {
    return null;
  }
}

/** Lê o que já está salvo (ativo ou não) de um provedor, já descriptografado. */
async function readStoredCredentials(userId, category, provider) {
  const rows = await prisma.setting.findMany({ where: { userId, category, provider } });
  const stored = {};
  for (const row of rows) {
    const plain = safeDecrypt(row.value);
    if (plain !== null) stored[row.key] = plain;
  }
  return stored;
}

/**
 * Junta o que o usuário enviou com o que já estava salvo:
 *  - tira espaços e quebras de linha das pontas;
 *  - segredo enviado em branco = "manter o que já está salvo";
 *  - campo comum enviado em branco = "apagar" (volta ao padrão).
 * Retorna { merged, toDelete }.
 */
async function mergeCredentials(userId, category, provider, incoming) {
  const stored = await readStoredCredentials(userId, category, provider);
  const merged = {};
  const toDelete = [];

  for (const [key, raw] of Object.entries(incoming || {})) {
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    if (value === '') {
      if (isSecretKey(key) && stored[key]) merged[key] = stored[key];
      else toDelete.push(key);
    } else {
      merged[key] = value;
    }
  }

  // Segredos que nem vieram na requisição continuam como estavam.
  for (const key of Object.keys(stored)) {
    if (isSecretKey(key) && merged[key] === undefined && !toDelete.includes(key)) merged[key] = stored[key];
  }

  return { merged, toDelete };
}

/**
 * Grava as credenciais numa única transação.
 * exclusive = true  -> desativa os OUTROS provedores da mesma categoria
 *                      (telefonia/e-mail: só um ativo por vez).
 * exclusive = false -> não mexe nos outros (IA: vários ao mesmo tempo).
 */
async function persistCredentials(userId, category, provider, merged, toDelete = [], { exclusive = false } = {}) {
  const ops = [];

  if (exclusive) {
    ops.push(prisma.setting.updateMany({ where: { userId, category, NOT: { provider } }, data: { isActive: false } }));
  }
  if (toDelete.length > 0) {
    ops.push(prisma.setting.deleteMany({ where: { userId, category, provider, key: { in: toDelete } } }));
  }
  for (const [key, value] of Object.entries(merged)) {
    ops.push(
      prisma.setting.upsert({
        where: { userId_category_provider_key: { userId, category, provider, key } },
        update: { value: encrypt(String(value)), isActive: true },
        create: { userId, category, provider, key, value: encrypt(String(value)), isActive: true }
      })
    );
  }

  await prisma.$transaction(ops);
}

/** Versão "segura para o navegador" de um provedor salvo: valores comuns + dicas dos segredos. */
function describeStored(stored) {
  const values = {};
  const hints = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isSecretKey(key)) hints[key] = maskSecret(value);
    else values[key] = value;
  }
  return { values, hints };
}

module.exports = {
  isSecretKey,
  maskSecret,
  readStoredCredentials,
  mergeCredentials,
  persistCredentials,
  describeStored
};
