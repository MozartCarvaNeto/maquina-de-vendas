// backend/src/services/pbx/didService.js
// Números (DID) da plataforma: estoque, atribuição aos clientes e atribuição automática.
const prisma = require('../../config/db');
const core = require('./pbxCore');
const { readStoredCredentials } = require('../settingsHelpers');

const digits = (s) => String(s || '').replace(/\D/g, '');

/** Aceita "5511999990000", "(11) 3000-0000", "+55 11 ..." (uma por linha ou separadas por vírgula/;). */
function parseNumbers(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || '').split(/[\n,;]+/)) {
    const d = digits(part);
    if (!d) continue;
    if (d.length < 8 || d.length > 15) { out.push({ raw: part.trim(), error: 'tamanho inválido' }); continue; }
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ number: d });
  }
  return out;
}

async function addToPool(numbers, label) {
  const added = [];
  const skipped = [];
  for (const n of parseNumbers(numbers)) {
    if (n.error) { skipped.push(`${n.raw}: ${n.error}`); continue; }
    const exists = await prisma.pbxDid.findUnique({ where: { number: n.number } });
    if (exists) { skipped.push(`${n.number}: já cadastrado`); continue; }
    added.push(await prisma.pbxDid.create({ data: { number: n.number, label: label ? String(label).slice(0, 60) : null } }));
  }
  return { added, skipped };
}

/** O número vira também um "número de discagem" (Linhas) da conta, para o discador/robô/IA usarem como identificador. */
async function syncCallerNumber(accountId, number, on) {
  const phone = `+${number}`;
  const found = await prisma.callerNumber.findFirst({ where: { userId: accountId, phoneNumber: phone } });
  if (on && !found) await prisma.callerNumber.create({ data: { userId: accountId, label: 'Número do serviço (nativo)', phoneNumber: phone, isActive: true } });
  if (!on && found) await prisma.callerNumber.delete({ where: { id: found.id } }).catch(() => null);
}

async function assign(didId, accountId) {
  const did = await prisma.pbxDid.findUnique({ where: { id: didId } });
  if (!did) throw Object.assign(new Error('Número não encontrado.'), { status: 404 });
  const acc = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!acc) throw Object.assign(new Error('Cliente não encontrado.'), { status: 404 });
  if (did.accountId && did.accountId !== accountId) await syncCallerNumber(did.accountId, did.number, false);
  const updated = await prisma.pbxDid.update({ where: { id: didId }, data: { accountId, assignedAt: new Date() } });
  await syncCallerNumber(accountId, did.number, true);
  return updated;
}

async function unassign(didId) {
  const did = await prisma.pbxDid.findUnique({ where: { id: didId } });
  if (!did) throw Object.assign(new Error('Número não encontrado.'), { status: 404 });
  if (did.accountId) await syncCallerNumber(did.accountId, did.number, false);
  return prisma.pbxDid.update({ where: { id: didId }, data: { accountId: null, assignedAt: null } });
}

/** Linhas "número;cliente" (cliente = e-mail de qualquer pessoa da conta ou o id da conta). */
async function assignMany(lines) {
  const done = [];
  const errors = [];
  for (const raw of String(lines || '').split('\n')) {
    const [numPart, clientPart] = raw.split(/[;\t]/).map((x) => (x || '').trim());
    if (!numPart && !clientPart) continue;
    const d = digits(numPart);
    const did = d ? await prisma.pbxDid.findUnique({ where: { number: d } }) : null;
    if (!did) { errors.push(`${numPart}: número não cadastrado`); continue; }
    let accountId = null;
    if (/@/.test(clientPart)) {
      const m = await prisma.member.findFirst({ where: { email: clientPart.toLowerCase() }, select: { accountId: true } });
      accountId = m?.accountId || null;
    } else {
      const a = clientPart ? await prisma.account.findUnique({ where: { id: clientPart }, select: { id: true } }) : null;
      accountId = a?.id || null;
    }
    if (!accountId) { errors.push(`${numPart}: cliente "${clientPart}" não encontrado`); continue; }
    await assign(did.id, accountId);
    done.push({ number: did.number, accountId });
  }
  return { done, errors };
}

async function forAccount(accountId) {
  return prisma.pbxDid.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
}

async function autoSettings() {
  const platform = await require('../platformService').platformAccountIds();
  for (const pid of platform) {
    const v = await readStoredCredentials(pid, 'platform_telecom', 'native').catch(() => ({}));
    if (v && Object.keys(v).length) return { auto: v.didAuto === 'true', count: Math.min(10, Math.max(1, parseInt(v.didAutoCount, 10) || 1)) };
  }
  return { auto: false, count: 1 };
}

/** Cliente com o serviço de telefonia e sem número: entrega o(s) primeiro(s) livre(s) do estoque. */
async function autoAssign(accountId) {
  const s = await autoSettings();
  if (!s.auto) return [];
  const have = await prisma.pbxDid.count({ where: { accountId } });
  if (have > 0) return [];
  const free = await prisma.pbxDid.findMany({ where: { accountId: null }, orderBy: { createdAt: 'asc' }, take: s.count });
  const got = [];
  for (const f of free) {
    // "reserva" atômica: só quem conseguir trocar null -> conta fica com o número
    const r = await prisma.pbxDid.updateMany({ where: { id: f.id, accountId: null }, data: { accountId, assignedAt: new Date() } });
    if (r.count) { await syncCallerNumber(accountId, f.number, true); got.push(f.number); }
  }
  return got;
}

/** Linhas do dialplan da plataforma: número chamado -> contexto de entrada do cliente (casa pelo final do número). */
async function dispatchRules() {
  const rows = await prisma.pbxDid.findMany({ where: { accountId: { not: null } } });
  return rows.map((r) => ({ digits: r.number, tag: core.tagFor(r.accountId) }));
}

module.exports = { parseNumbers, addToPool, assign, unassign, assignMany, forAccount, autoAssign, autoSettings, dispatchRules, syncCallerNumber };
