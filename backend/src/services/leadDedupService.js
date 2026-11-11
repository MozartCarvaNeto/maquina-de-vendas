// backend/src/services/leadDedupService.js
//
// Contatos duplicados: compara TELEFONE e E-MAIL.
//  - phoneKey: DDD + últimos 8 dígitos (ignora +55, zero à esquerda e o
//    "9" extra do celular, então 11 98888-7777 e 11 8888-7777 são o mesmo).
//  - emailKey: e-mail em minúsculas, sem espaços.
// Usado na importação, no cadastro manual e na limpeza dos já existentes.
const prisma = require('../config/db');

function phoneKey(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length < 8) return null;
  const last8 = d.slice(-8);
  // com DDD (10 ou 11 dígitos): DDD + 8 finais; sem DDD: só os 8 finais
  return d.length >= 10 ? `${d.slice(0, 2)}${last8}` : last8;
}

function emailKey(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e && e.includes('@') ? e : null;
}

function keysOf(lead) {
  const keys = [];
  const p = phoneKey(lead.phone);
  const e = emailKey(lead.email);
  if (p) keys.push(`p:${p}`);
  if (e) keys.push(`e:${e}`);
  return keys;
}

/** Índice dos leads existentes da conta: chave -> lead (o mais antigo). */
async function buildIndex(userId) {
  const leads = await prisma.lead.findMany({
    where: { userId },
    select: { id: true, name: true, phone: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });
  const index = new Map();
  for (const lead of leads) {
    for (const k of keysOf(lead)) if (!index.has(k)) index.set(k, lead);
  }
  return { index, leads };
}

function findInIndex(index, candidate) {
  for (const k of keysOf(candidate)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}

function addToIndex(index, lead) {
  for (const k of keysOf(lead)) if (!index.has(k)) index.set(k, lead);
}

/** Grupos de duplicados já existentes (união por telefone OU e-mail). */
async function scanDuplicates(userId) {
  const { leads } = await buildIndex(userId);
  const parent = new Map(leads.map((l) => [l.id, l.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  const owner = new Map();
  for (const lead of leads) {
    for (const k of keysOf(lead)) {
      if (owner.has(k)) union(lead.id, owner.get(k));
      else owner.set(k, lead.id);
    }
  }
  const groups = new Map();
  for (const lead of leads) {
    const root = find(lead.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(lead);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.createdAt - b.createdAt))
    .map((g) => ({
      keepId: g[0].id, // sugestão: o mais antigo
      leads: g.map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, createdAt: l.createdAt }))
    }));
}

/** Modelos do Prisma que apontam para Lead (campo leadId) — lidos do próprio schema. */
function leadRelations() {
  const { Prisma } = require('@prisma/client');
  const models = (Prisma.dmmf && Prisma.dmmf.datamodel && Prisma.dmmf.datamodel.models) || [];
  const out = [];
  for (const m of models) {
    for (const f of m.fields) {
      if (f.kind === 'object' && f.type === 'Lead' && f.relationFromFields && f.relationFromFields.length === 1) {
        out.push({ model: m.name[0].toLowerCase() + m.name.slice(1), field: f.relationFromFields[0] });
      }
    }
  }
  return out;
}

/** Junta os duplicados em um só: o "keep" recebe dados faltantes e todos os históricos. */
async function mergeLeads(userId, keepId, removeIds) {
  const keep = await prisma.lead.findFirst({ where: { id: keepId, userId } });
  if (!keep) throw Object.assign(new Error('Contato a manter não encontrado'), { status: 404 });
  const others = await prisma.lead.findMany({
    where: { id: { in: removeIds.filter((id) => id !== keepId) }, userId }
  });
  if (!others.length) return { merged: 0 };

  const patch = {};
  for (const f of ['phone', 'email', 'address']) {
    if (!keep[f]) {
      const v = others.map((o) => o[f]).find(Boolean);
      if (v) patch[f] = v;
    }
  }
  patch.tags = [...new Set([...(keep.tags || []), ...others.flatMap((o) => o.tags || [])])];
  if (others.some((o) => o.optOut)) patch.optOut = true; // quem pediu para sair continua fora

  const relations = leadRelations();
  for (const other of others) {
    for (const { model, field } of relations) {
      const delegate = prisma[model];
      if (!delegate) continue;
      try {
        await delegate.updateMany({ where: { [field]: other.id }, data: { [field]: keepId } });
      } catch (_e) {
        // conflito de chave única (ex.: o outro já está na mesma lista): move linha a linha;
        // o que não puder mover é apagado junto com o contato duplicado (cascata).
        const rows = await delegate.findMany({ where: { [field]: other.id }, select: { id: true } }).catch(() => []);
        for (const row of rows) {
          await delegate.update({ where: { id: row.id }, data: { [field]: keepId } }).catch(() => {});
        }
      }
    }
    await prisma.lead.delete({ where: { id: other.id } });
  }
  await prisma.lead.update({ where: { id: keepId }, data: patch });
  return { merged: others.length };
}

module.exports = { phoneKey, emailKey, keysOf, buildIndex, findInIndex, addToIndex, scanDuplicates, mergeLeads };
