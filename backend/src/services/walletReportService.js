// backend/src/services/walletReportService.js
// Extrato do cliente (minutos, SMS, mensalidades) e painel de lucro do administrador.
const prisma = require('../config/db');
const rules = require('./platformBillingSettings');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const monthRange = (key) => { const [y, m] = key.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 1, 1, 3)), to: new Date(Date.UTC(y, m, 1, 3)) }; }; // mês no horário de Brasília

/** Categoria de uma movimentação do extrato. */
function category(t) {
  if (t.type === 'recarga') return 'recarga';
  if (t.type === 'voz') return 'voz';
  if (t.type === 'sms') return 'sms';
  if (t.type === 'did_fee') return 'numero';
  if (t.type === 'whatsapp' || t.type === 'repasse' || t.type === 'atacado') return 'outros';
  if (t.type === 'estorno' && /WhatsApp/i.test(t.description || '')) return 'outros';
  if (t.type === 'estorno') return /SMS/i.test(t.description || '') ? 'sms' : 'voz';
  return 'outros';
}

function parseDay(s, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  return new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}-03:00`);
}

async function statement(userId, { from, to } = {}) {
  const now = new Date();
  const start = parseDay(from) || new Date(now.getTime() - 30 * 864e5);
  const end = parseDay(to, true) || now;
  const rows = await prisma.walletTx.findMany({ where: { userId, createdAt: { gte: start, lte: end } }, orderBy: { createdAt: 'desc' }, take: 5000 });
  const sum = { recarga: 0, voz: { amountBrl: 0, minutes: 0, calls: 0 }, sms: { amountBrl: 0, parts: 0, messages: 0 }, numero: { amountBrl: 0, charges: 0 }, estornos: 0, outros: 0 };
  for (const t of rows) {
    const c = category(t);
    const used = -t.amountBrl; // gasto positivo
    if (c === 'recarga') sum.recarga += t.amountBrl;
    else if (c === 'voz') { sum.voz.amountBrl += used; if (t.type === 'voz') { sum.voz.minutes += (t.quantity || 0) / 60; sum.voz.calls++; } else sum.estornos += t.amountBrl; }
    else if (c === 'sms') { sum.sms.amountBrl += used; if (t.type === 'sms') { sum.sms.parts += t.quantity || 0; sum.sms.messages++; } else sum.estornos += t.amountBrl; }
    else if (c === 'numero') { sum.numero.amountBrl += used; sum.numero.charges++; }
    else sum.outros += t.amountBrl;
  }
  sum.recarga = r2(sum.recarga); sum.voz.amountBrl = r2(sum.voz.amountBrl); sum.voz.minutes = r2(sum.voz.minutes);
  sum.sms.amountBrl = r2(sum.sms.amountBrl); sum.numero.amountBrl = r2(sum.numero.amountBrl); sum.estornos = r2(sum.estornos); sum.outros = r2(sum.outros);
  return { from: start, to: end, summary: sum, txs: rows.map((t) => ({ id: t.id, createdAt: t.createdAt, type: t.type, category: category(t), description: t.description, amountBrl: t.amountBrl, balanceAfter: t.balanceAfter, quantity: t.quantity || 0 })) };
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function statementCsv(st) {
  const head = ['Data', 'Tipo', 'Descrição', 'Valor (R$)', 'Saldo após (R$)', 'Quantidade'];
  const lines = st.txs.map((t) => [new Date(t.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), t.category, t.description, t.amountBrl.toFixed(2).replace('.', ','), t.balanceAfter.toFixed(2).replace('.', ','), t.quantity].map(csvCell).join(';'));
  return `﻿${[head.map(csvCell).join(';'), ...lines].join('\r\n')}\r\n`;
}

/** Lucro por mês: o que os clientes pagaram (carteira) menos o que a plataforma paga ao fornecedor. */
async function profit({ months = 6, month = null } = {}) {
  const r = await rules.get();
  const platform = new Set(await require('./platformService').platformAccountIds());
  const now = new Date();
  const keys = [];
  for (let i = 0; i < Math.min(24, Math.max(1, months)); i++) keys.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  if (month && !keys.includes(month)) keys.push(month);
  const out = [];
  for (const key of keys) {
    const { from, to } = monthRange(key);
    const txs = (await prisma.walletTx.findMany({ where: { createdAt: { gte: from, lt: to } }, take: 200000 })).filter((t) => !platform.has(t.userId));
    const sms = await prisma.smsMessage.findMany({ where: { createdAt: { gte: from, lt: to }, direction: 'out' }, select: { userId: true, costBrl: true, parts: true, status: true }, take: 200000 }).catch(() => []);
    const row = { month: key, topups: 0, voice: { revenue: 0, cost: 0, minutes: 0 }, sms: { revenue: 0, cost: 0, parts: 0 }, numbers: { revenue: 0, cost: 0, charges: 0 }, byAccount: {} };
    const acc = (id) => (row.byAccount[id] = row.byAccount[id] || { accountId: id, revenue: 0, cost: 0 });
    for (const t of txs) {
      const c = category(t);
      if (c === 'recarga') { row.topups += t.amountBrl; continue; }
      const used = -t.amountBrl;
      if (c === 'voz') { row.voice.revenue += used; row.voice.cost += t.costBrl || 0; if (t.type === 'voz') row.voice.minutes += (t.quantity || 0) / 60; acc(t.userId).revenue += used; acc(t.userId).cost += t.costBrl || 0; }
      else if (c === 'sms') { row.sms.revenue += used; if (t.type === 'sms') row.sms.parts += t.quantity || 0; acc(t.userId).revenue += used; }
      else if (c === 'numero') { row.numbers.revenue += used; row.numbers.cost += t.costBrl || 0; row.numbers.charges++; acc(t.userId).revenue += used; acc(t.userId).cost += t.costBrl || 0; }
    }
    for (const m of sms) {
      if (platform.has(m.userId) || ['failed', 'queued'].includes(m.status)) continue;
      const c = m.costBrl > 0 ? m.costBrl : (r.smsCostFallbackBrl || 0) * (m.parts || 1);
      row.sms.cost += c; acc(m.userId).cost += c;
    }
    const total = { revenue: row.voice.revenue + row.sms.revenue + row.numbers.revenue, cost: row.voice.cost + row.sms.cost + row.numbers.cost };
    out.push({
      month: key, topups: r2(row.topups),
      voice: { revenue: r2(row.voice.revenue), cost: r2(row.voice.cost), profit: r2(row.voice.revenue - row.voice.cost), minutes: r2(row.voice.minutes) },
      sms: { revenue: r2(row.sms.revenue), cost: r2(row.sms.cost), profit: r2(row.sms.revenue - row.sms.cost), parts: row.sms.parts },
      numbers: { revenue: r2(row.numbers.revenue), cost: r2(row.numbers.cost), profit: r2(row.numbers.revenue - row.numbers.cost), charges: row.numbers.charges },
      total: { revenue: r2(total.revenue), cost: r2(total.cost), profit: r2(total.revenue - total.cost), marginPct: total.revenue > 0 ? r2(((total.revenue - total.cost) / total.revenue) * 100) : 0 },
      byAccount: Object.values(row.byAccount).map((a) => ({ ...a, revenue: r2(a.revenue), cost: r2(a.cost), profit: r2(a.revenue - a.cost) })).sort((a, b) => b.profit - a.profit)
    });
  }
  const names = new Map((await prisma.account.findMany({ select: { id: true, name: true }, take: 5000 })).map((a) => [a.id, a.name]));
  out.forEach((m) => m.byAccount.forEach((a) => { a.name = names.get(a.accountId) || a.accountId; }));
  out.sort((a, b) => (a.month < b.month ? 1 : -1));
  return { months: out, rules: r };
}

module.exports = { statement, statementCsv, profit, category };
