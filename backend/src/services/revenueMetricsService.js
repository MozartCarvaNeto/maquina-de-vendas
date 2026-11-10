// backend/src/services/revenueMetricsService.js
// Painel financeiro do administrador: receita recorrente (MRR), clientes, inadimplência, cancelamentos
// e receita por mês (planos + recargas). O lucro do uso de telefonia continua em walletReportService.profit.
const prisma = require('../config/db');
const { computeAccess, isPlatformAdminEmail } = require('./accessService');

const r2 = (n) => Math.round(n * 100) / 100;
const DAY = 24 * 3600 * 1000;
const monthKey = (d) => d.toISOString().slice(0, 7);

/** Valor mensal equivalente do plano (anual R$ 1.200 = R$ 100/mês). */
function monthlyValue(plan) {
  if (!plan || !plan.priceCents) return 0;
  return plan.priceCents / Math.max(1, plan.cycleMonths || 1) / 100;
}

async function overview({ months = 6, now = new Date() } = {}) {
  const accounts = await prisma.account.findMany({
    include: { subscriptionPlan: true, members: { select: { email: true, role: true, name: true } } },
    take: 20000
  });
  const clients = accounts.filter((a) => !a.members.some((m) => isPlatformAdminEmail(m.email)));
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since60 = new Date(now.getTime() - 60 * DAY);

  const c = { total: clients.length, pending: 0, trial: 0, paying: 0, grace: 0, expired: 0, blocked: 0, newLast30: 0 };
  let mrr = 0;
  const atRisk = []; // vence nos próximos 7 dias ou já está em carência
  const delinquent = [];
  const byPlan = {};
  const churned = []; // venceu (além da carência) ou foi bloqueado nos últimos 30 dias, tinha plano pago

  for (const a of clients) {
    const acc = computeAccess(a, now);
    const owner = a.members.find((m) => m.role === 'owner') || a.members[0];
    const info = { id: a.id, name: a.name, owner: owner?.email || null, plan: a.subscriptionPlan?.name || a.plan || '—', endsAt: a.subscriptionEndsAt, value: r2(monthlyValue(a.subscriptionPlan)) };
    if (new Date(a.createdAt) >= since30) c.newLast30++;
    if (acc.status === 'pendente') { c.pending++; continue; }
    if (acc.status === 'bloqueada') { c.blocked++; if (a.planId) churned.push(info); continue; }
    if (acc.status === 'expirada') {
      c.expired++;
      delinquent.push({ ...info, daysOverdue: a.subscriptionEndsAt ? Math.floor((now - new Date(a.subscriptionEndsAt)) / DAY) : null });
      if (a.planId && a.subscriptionEndsAt && new Date(a.subscriptionEndsAt) >= new Date(since30.getTime() - 15 * DAY)) churned.push(info);
      continue;
    }
    if (acc.inGrace) { c.grace++; delinquent.push({ ...info, daysOverdue: Math.floor((now - new Date(a.subscriptionEndsAt)) / DAY), inGrace: true }); }
    if (!a.planId) { c.trial++; if (acc.daysLeft !== null && acc.daysLeft <= 3) atRisk.push({ ...info, daysLeft: acc.daysLeft, trial: true }); continue; }
    c.paying++;
    mrr += monthlyValue(a.subscriptionPlan);
    const key = a.subscriptionPlan?.name || '—';
    (byPlan[key] = byPlan[key] || { plan: key, clients: 0, mrr: 0 });
    byPlan[key].clients++;
    byPlan[key].mrr += monthlyValue(a.subscriptionPlan);
    if (acc.daysLeft !== null && acc.daysLeft <= 7 && !acc.inGrace) atRisk.push({ ...info, daysLeft: acc.daysLeft });
  }

  // receita por mês: planos pagos + recargas
  const keys = [];
  for (let i = 0; i < Math.min(24, Math.max(1, months)); i++) keys.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  const from = new Date(`${keys[keys.length - 1]}-01T00:00:00Z`);
  const [pays, tops] = await Promise.all([
    prisma.billingPayment.findMany({ where: { paidAt: { gte: from } }, select: { accountId: true, amountCents: true, paidAt: true }, take: 100000 }),
    prisma.walletTopup.findMany({ where: { status: 'paid', paidAt: { gte: from } }, select: { accountId: true, amountCents: true, paidAt: true }, take: 100000 }).catch(() => [])
  ]);
  const series = keys.map((k) => ({ month: k, plans: 0, topups: 0 }));
  const idx = new Map(series.map((s) => [s.month, s]));
  for (const p of pays) { const s = idx.get(monthKey(new Date(p.paidAt))); if (s) s.plans += p.amountCents / 100; }
  for (const t of tops) { const s = idx.get(monthKey(new Date(t.paidAt))); if (s) s.topups += t.amountCents / 100; }
  series.forEach((s) => { s.plans = r2(s.plans); s.topups = r2(s.topups); s.total = r2(s.plans + s.topups); });
  series.sort((a, b) => (a.month < b.month ? 1 : -1));

  const base = c.paying + churned.length; // quem pagava há ~30 dias
  const churnRatePct = base > 0 ? r2((churned.length / base) * 100) : 0;
  const delinquentValue = r2(delinquent.reduce((s, d) => s + (d.value || 0), 0));
  void since60;
  return {
    generatedAt: now.toISOString(),
    clients: c,
    mrr: r2(mrr),
    arr: r2(mrr * 12),
    arpu: c.paying ? r2(mrr / c.paying) : 0,
    churn: { last30: churned.length, ratePct: churnRatePct, accounts: churned.slice(0, 50) },
    delinquent: { count: delinquent.length, monthlyValue: delinquentValue, accounts: delinquent.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0)).slice(0, 100) },
    atRisk: atRisk.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 100),
    byPlan: Object.values(byPlan).map((p) => ({ ...p, mrr: r2(p.mrr) })).sort((a, b) => b.mrr - a.mrr),
    revenue: series
  };
}

module.exports = { overview, monthlyValue };
