// backend/src/services/optOutService.js
// Lista de bloqueio por conta: números que pediram para não ser contatados.
// Vale para SMS, ligações (manual, discador, robô, IA) e disparos.
const prisma = require('../config/db');
const { toE164BR } = require('../utils/phone');

const CHANNELS = ['all', 'sms', 'voice', 'whatsapp'];

/** Só dígitos, sempre com 55 na frente (número brasileiro). null se inválido. */
function normalize(raw) {
  const e = toE164BR(raw);
  return e ? e.replace(/\D/g, '') : null;
}

function channelsFor(channel) {
  return channel === 'all' ? ['all'] : ['all', channel];
}

/** Este número está bloqueado neste canal? Nunca derruba o envio se o banco falhar. */
async function isBlocked(accountId, phone, channel = 'all') {
  const n = normalize(phone);
  if (!n || !accountId) return false;
  try {
    const row = await prisma.optOut.findFirst({ where: { accountId, phone: n, channel: { in: channelsFor(channel) } }, select: { id: true } });
    return !!row;
  } catch (_) {
    return false;
  }
}

async function add(accountId, phone, { channel = 'all', source = 'manual', reason = null } = {}) {
  const n = normalize(phone);
  if (!n) throw Object.assign(new Error(`Telefone inválido: "${phone}"`), { status: 400 });
  if (!CHANNELS.includes(channel)) channel = 'all';
  return prisma.optOut.upsert({
    where: { accountId_phone_channel: { accountId, phone: n, channel } },
    update: { reason: reason ? String(reason).slice(0, 200) : undefined },
    create: { accountId, phone: n, channel, source, reason: reason ? String(reason).slice(0, 200) : null }
  });
}

/** Igual a add, mas nunca lança erro (para ser chamado dentro de outros fluxos). */
async function addQuiet(accountId, phone, opts) {
  try { return await add(accountId, phone, opts); } catch (_) { return null; }
}

async function remove(accountId, id) {
  const r = await prisma.optOut.deleteMany({ where: { id, accountId } });
  if (!r.count) throw Object.assign(new Error('Registro não encontrado.'), { status: 404 });
}

async function list(accountId, { q = '', take = 200 } = {}) {
  const digits = String(q || '').replace(/\D/g, '');
  const where = { accountId, ...(digits ? { phone: { contains: digits } } : {}) };
  const [items, total] = await Promise.all([
    prisma.optOut.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(500, take) }),
    prisma.optOut.count({ where: { accountId } })
  ]);
  return { items, total };
}

/** Importa vários números (um por linha, vírgula ou ponto e vírgula). */
async function importMany(accountId, text, { channel = 'all', reason = 'Importado' } = {}) {
  const parts = String(text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5000);
  let added = 0;
  const invalid = [];
  for (const p of parts) {
    const n = normalize(p);
    if (!n) { invalid.push(p); continue; }
    await add(accountId, p, { channel, source: 'import', reason });
    added += 1;
  }
  return { added, invalid: invalid.slice(0, 20), invalidCount: invalid.length };
}

module.exports = { normalize, isBlocked, add, addQuiet, remove, list, importMany, CHANNELS };
