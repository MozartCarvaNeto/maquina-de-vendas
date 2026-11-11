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
  if (did.accountId !== accountId) {
    const lim = await require('../telecomLimitService').checkDids(accountId, 1);
    if (!lim.ok) throw Object.assign(new Error(lim.message), { status: 409 });
  }
  if (did.accountId && did.accountId !== accountId) await syncCallerNumber(did.accountId, did.number, false);
  const now = new Date();
  const moved = did.accountId !== accountId;
  const updated = await prisma.pbxDid.update({ where: { id: didId }, data: { accountId, assignedAt: moved ? now : did.assignedAt || now, ...(moved ? { nextBillAt: now, lastBilledAt: null, overdueSince: null, suspendedAt: null } : {}) } });
  await syncCallerNumber(accountId, did.number, true);
  return updated;
}

async function unassign(didId) {
  const did = await prisma.pbxDid.findUnique({ where: { id: didId } });
  if (!did) throw Object.assign(new Error('Número não encontrado.'), { status: 404 });
  if (did.accountId) await syncCallerNumber(did.accountId, did.number, false);
  return prisma.pbxDid.update({ where: { id: didId }, data: { accountId: null, assignedAt: null, nextBillAt: null, lastBilledAt: null, overdueSince: null, suspendedAt: null } });
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
    if (v && Object.keys(v).length) {
      return {
        auto: v.didAuto === 'true',
        count: Math.min(10, Math.max(1, parseInt(v.didAutoCount, 10) || 1)),
        feeBrl: Math.max(0, Number(v.didFeeBrl) || 0),
        graceDays: Math.min(60, Math.max(0, v.didGraceDays === undefined || v.didGraceDays === '' ? 5 : parseInt(v.didGraceDays, 10) || 0)),
        autoSuspend: v.didAutoSuspend !== 'false',
        billing: v.didBilling === 'true',
        platformId: pid
      };
    }
  }
  return { auto: false, count: 1, feeBrl: 0, graceDays: 5, autoSuspend: true, billing: false, platformId: platform[0] || null };
}

/** Grava as regras (só o que vier na requisição muda; o resto continua como estava). */
async function saveSettings(input = {}) {
  const cur = await autoSettings();
  if (!cur.platformId) throw Object.assign(new Error('Nenhuma conta de administrador da plataforma encontrada (SUPERADMIN_EMAILS).'), { status: 400 });
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const next = {
    didAuto: String(input.auto !== undefined ? Boolean(input.auto) : cur.auto),
    didAutoCount: String(Math.min(10, Math.max(1, parseInt(input.count !== undefined ? input.count : cur.count, 10) || 1))),
    didFeeBrl: String(Math.max(0, Math.round(num(input.feeBrl, cur.feeBrl) * 100) / 100)),
    didGraceDays: String(Math.min(60, Math.max(0, parseInt(input.graceDays !== undefined ? input.graceDays : cur.graceDays, 10) || 0))),
    didAutoSuspend: String(input.autoSuspend !== undefined ? Boolean(input.autoSuspend) : cur.autoSuspend),
    didBilling: String(input.billing !== undefined ? Boolean(input.billing) : cur.billing)
  };
  const { persistCredentials } = require('../settingsHelpers');
  // mantém as outras chaves do provedor "native" (ex.: dados do SMS) e não desativa o resto
  const stored = await readStoredCredentials(cur.platformId, 'platform_telecom', 'native').catch(() => ({}));
  await persistCredentials(cur.platformId, 'platform_telecom', 'native', { ...stored, ...next }, [], { exclusive: true });
  return autoSettings();
}

const addMonth = (d) => { const x = new Date(d); x.setMonth(x.getMonth() + 1); return x; };
const feeOf = (did, s) => (did.monthlyFeeBrl === null || did.monthlyFeeBrl === undefined ? s.feeBrl : Math.max(0, did.monthlyFeeBrl));

/** Cobra as mensalidades vencidas (e retoma / suspende conforme o saldo). Devolve as contas que mudaram de estado. */
async function runBilling(now = new Date()) {
  const s = await autoSettings();
  const out = { charged: 0, failed: 0, suspended: [], unsuspended: [], skipped: 0, changedAccounts: [] };
  if (!s.billing) return out;
  const platform = new Set(await require('../platformService').platformAccountIds());
  const wallet = require('../walletService');
  const rows = await prisma.pbxDid.findMany({ where: { accountId: { not: null } }, orderBy: { createdAt: 'asc' } });
  const changed = new Set();
  for (const did of rows) {
    if (platform.has(did.accountId)) continue;
    const fee = feeOf(did, s);
    if (!(fee > 0)) { if (did.nextBillAt) await prisma.pbxDid.update({ where: { id: did.id }, data: { nextBillAt: null, overdueSince: null } }); continue; }
    const due = did.nextBillAt || did.assignedAt || now;
    if (new Date(due) > now) { out.skipped++; continue; }
    const w = await wallet.isActive(did.accountId);
    if (!w) {
      // carteira desligada = conta liberada (comportamento antigo): não cobra, só avança o mês
      await prisma.pbxDid.update({ where: { id: did.id }, data: { nextBillAt: addMonth(due), overdueSince: null } });
      out.skipped++;
      continue;
    }
    try {
      await wallet.charge(did.accountId, fee, { type: 'did_fee', description: `Mensalidade do número +${did.number}`, refId: did.id, costBrl: (await require('../platformBillingSettings').get().catch(() => ({ didCostMonthlyBrl: 0 }))).didCostMonthlyBrl, quantity: 1 });
      const data = { lastBilledAt: now, nextBillAt: addMonth(new Date(due).getTime() < now.getTime() - 62 * 864e5 ? now : due), overdueSince: null };
      if (did.suspendedAt) { data.suspendedAt = null; out.unsuspended.push(did.number); changed.add(did.accountId); }
      await prisma.pbxDid.update({ where: { id: did.id }, data });
      out.charged++;
    } catch (e) {
      if (e.status !== 402) throw e;
      out.failed++;
      const since = did.overdueSince || now;
      const data = { overdueSince: since };
      const days = (now.getTime() - new Date(since).getTime()) / 864e5;
      if (s.autoSuspend && !did.suspendedAt && days >= s.graceDays) { data.suspendedAt = now; out.suspended.push(did.number); changed.add(did.accountId); }
      await prisma.pbxDid.update({ where: { id: did.id }, data });
    }
  }
  out.changedAccounts = [...changed];
  return out;
}

/** Quando o administrador (ou o cliente) põe saldo, tenta cobrar o que está em atraso dessa conta. */
async function billAccount(accountId) {
  const s = await autoSettings();
  if (!s.billing) return { changedAccounts: [] };
  const only = await prisma.pbxDid.findMany({ where: { accountId, overdueSince: { not: null } }, select: { id: true } });
  if (!only.length) return { changedAccounts: [] };
  return runBilling();
}

/** Todos os clientes ativos com o serviço e sem número recebem o do estoque (não depende de abrir a tela). */
async function autoAssignSweep() {
  const s = await autoSettings();
  const res = { assigned: [], accounts: [] };
  if (!s.auto) return res;
  const platform = new Set(await require('../platformService').platformAccountIds());
  const without = new Set(await require('../featureService').getAccountIdsWithoutFeature('gateway'));
  const accounts = await prisma.account.findMany({ where: { accessStatus: 'ativa' }, select: { id: true }, take: 5000 });
  for (const a of accounts) {
    if (platform.has(a.id) || without.has(a.id)) continue;
    const got = await autoAssign(a.id);
    if (got.length) { res.assigned.push(...got); res.accounts.push(a.id); }
  }
  return res;
}

/** Edita um número já cadastrado: dígitos, rótulo, mensalidade própria (null = padrão), próximo vencimento. */
async function updateDid(id, input = {}) {
  const did = await prisma.pbxDid.findUnique({ where: { id } });
  if (!did) throw Object.assign(new Error('Número não encontrado.'), { status: 404 });
  const data = {};
  if (input.number !== undefined) {
    const d = digits(input.number);
    if (d.length < 8 || d.length > 15) throw Object.assign(new Error('Número inválido (8 a 15 dígitos).'), { status: 400 });
    if (d !== did.number) {
      const dup = await prisma.pbxDid.findUnique({ where: { number: d } });
      if (dup) throw Object.assign(new Error('Já existe um número cadastrado com esses dígitos.'), { status: 409 });
      data.number = d;
    }
  }
  if (input.label !== undefined) data.label = input.label ? String(input.label).slice(0, 60) : null;
  if (input.monthlyFeeBrl !== undefined) {
    if (input.monthlyFeeBrl === null || input.monthlyFeeBrl === '') data.monthlyFeeBrl = null;
    else {
      const n = Number(input.monthlyFeeBrl);
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw Object.assign(new Error('Mensalidade inválida.'), { status: 400 });
      data.monthlyFeeBrl = Math.round(n * 100) / 100;
    }
  }
  if (input.nextBillAt !== undefined) {
    if (!input.nextBillAt) data.nextBillAt = null;
    else {
      const t = new Date(input.nextBillAt);
      if (Number.isNaN(t.getTime())) throw Object.assign(new Error('Data de vencimento inválida.'), { status: 400 });
      data.nextBillAt = t;
    }
  }
  if (input.suspended !== undefined && did.accountId) {
    data.suspendedAt = input.suspended ? (did.suspendedAt || new Date()) : null;
    if (!input.suspended) data.overdueSince = null;
  }
  const updated = await prisma.pbxDid.update({ where: { id }, data });
  if (data.number && did.accountId) {
    await syncCallerNumber(did.accountId, did.number, false);
    await syncCallerNumber(did.accountId, data.number, true);
  }
  return updated;
}

/** Cliente com o serviço de telefonia e sem número: entrega o(s) primeiro(s) livre(s) do estoque. */
async function autoAssign(accountId) {
  const s = await autoSettings();
  if (!s.auto) return [];
  const have = await prisma.pbxDid.count({ where: { accountId } });
  if (have > 0) return [];
  // respeita o limite de números do plano
  const room = await require('../telecomLimitService').checkDids(accountId, 0);
  const cap = room.limit == null ? s.count : Math.max(0, Math.min(s.count, room.limit - room.used));
  if (cap <= 0) return [];
  const free = await prisma.pbxDid.findMany({ where: { accountId: null }, orderBy: { createdAt: 'asc' }, take: cap });
  const got = [];
  for (const f of free) {
    // "reserva" atômica: só quem conseguir trocar null -> conta fica com o número
    const r = await prisma.pbxDid.updateMany({ where: { id: f.id, accountId: null }, data: { accountId, assignedAt: new Date(), nextBillAt: new Date() } });
    if (r.count) { await syncCallerNumber(accountId, f.number, true); got.push(f.number); }
  }
  return got;
}

/** Linhas do dialplan da plataforma: número chamado -> contexto de entrada do cliente (casa pelo final do número). */
async function dispatchRules() {
  const rows = await prisma.pbxDid.findMany({ where: { accountId: { not: null }, suspendedAt: null } });
  return rows.map((r) => ({ digits: r.number, tag: core.tagFor(r.accountId) }));
}

module.exports = { saveSettings, runBilling, billAccount, autoAssignSweep, updateDid, parseNumbers, addToPool, assign, unassign, assignMany, forAccount, autoAssign, autoSettings, dispatchRules, syncCallerNumber };
