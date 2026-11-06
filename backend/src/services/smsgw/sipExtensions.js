// backend/src/services/smsgw/sipExtensions.js
// Ramais SIP (um por pessoa da equipe) para o telefone no navegador.
const crypto = require('crypto');
const prisma = require('../../config/db');
const { encrypt } = require('../crypto/settingsCrypto');

async function ensureExtensionForMember(userId, memberId) {
  const existing = await prisma.sipExtension.findUnique({ where: { memberId } });
  if (existing) return existing;
  const taken = await prisma.sipExtension.findMany({ where: { userId }, select: { extension: true } });
  const used = new Set(taken.map((t) => t.extension));
  // ramais de 4 dígitos por conta; contas diferentes podem repetir número, mas o Asterisk é único:
  // por isso o ramal leva um prefixo curto do código da conta (ex.: 7a31001).
  const prefix = crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 4);
  let n = 1001;
  while (used.has(`${prefix}${n}`)) n += 1;
  const password = crypto.randomBytes(18).toString('base64url');
  return prisma.sipExtension.create({
    data: { userId, memberId, extension: `${prefix}${n}`, passwordEnc: encrypt(password) }
  });
}

/** Garante um ramal para cada pessoa ativa da conta e devolve a lista com o nome. */
async function ensureAllExtensions(userId) {
  const members = await prisma.member.findMany({ where: { accountId: userId, status: 'ativo' }, select: { id: true, name: true } });
  const out = [];
  for (const m of members) {
    const ext = await ensureExtensionForMember(userId, m.id);
    out.push({ ...ext, name: m.name });
  }
  return out;
}

module.exports = { ensureExtensionForMember, ensureAllExtensions };
