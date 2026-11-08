// backend/src/services/platformService.js
// Quem é "a plataforma": as contas dos administradores (e-mails em SUPERADMIN_EMAILS).
// Troncos SIP, fornecedores SMPP e chaves de voz são só deles; os clientes usam por crédito/saldo.
const prisma = require('../config/db');
const env = require('../config/env');

let cache = { ids: [], at: 0 };
const TTL = 60 * 1000;

async function platformAccountIds(force = false) {
  if (!force && Date.now() - cache.at < TTL) return cache.ids;
  try {
    const emails = env.superAdminEmails || [];
    const rows = emails.length ? await prisma.member.findMany({ where: { email: { in: emails } }, select: { accountId: true } }) : [];
    cache = { ids: [...new Set(rows.map((r) => r.accountId))], at: Date.now() };
  } catch (e) {
    cache = { ids: cache.ids, at: Date.now() - TTL + 5000 };
  }
  return cache.ids;
}

/** Leitura imediata (usa o último valor carregado). */
function platformAccountIdsSync() {
  return cache.ids;
}

async function isPlatformAccount(userId) {
  return (await platformAccountIds()).includes(userId);
}

module.exports = { platformAccountIds, platformAccountIdsSync, isPlatformAccount, _reset: () => { cache = { ids: [], at: 0 }; } };
