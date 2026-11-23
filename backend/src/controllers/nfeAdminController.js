// backend/src/controllers/nfeAdminController.js
//
// Administrador da plataforma: planos do emissor de NF-e (preço, ciclo, notas por mês) e assinaturas dos clientes.
const prisma = require('../config/db');
const nfe = require('../services/nfe/nfeService');

function parsePlan(body, { partial }) {
  const data = {};
  const err = (m) => ({ error: m });
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return err('Informe o nome do plano.');
    data.name = name.slice(0, 80);
  }
  if (body.description !== undefined) data.description = String(body.description || '').trim().slice(0, 300) || null;
  if (!partial || body.priceCents !== undefined) {
    const cents = Math.round(Number(body.priceCents));
    if (!Number.isFinite(cents) || cents < 0) return err('Preço inválido.');
    data.priceCents = cents;
  }
  if (!partial || body.cycleMonths !== undefined) {
    const c = Number(body.cycleMonths ?? 1);
    if (![1, 3, 6, 12].includes(c)) return err('O ciclo precisa ser 1, 3, 6 ou 12 meses.');
    data.cycleMonths = c;
  }
  if (body.maxMonthlyNotes !== undefined) {
    if (body.maxMonthlyNotes === null || body.maxMonthlyNotes === '') data.maxMonthlyNotes = null;
    else {
      const n = Math.floor(Number(body.maxMonthlyNotes));
      if (!Number.isFinite(n) || n < 1) return err('O limite de notas por mês precisa ser um número maior que zero (ou vazio para ilimitado).');
      data.maxMonthlyNotes = n;
    }
  }
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  if (body.isPublic !== undefined) data.isPublic = Boolean(body.isPublic);
  if (body.sortOrder !== undefined) data.sortOrder = Math.floor(Number(body.sortOrder) || 0);
  return { data };
}

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await prisma.nfePlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }], include: { _count: { select: { subscriptions: true } } } });
    res.json({ plans });
  } catch (e) { next(e); }
};

exports.createPlan = async (req, res, next) => {
  try {
    const { data, error } = parsePlan(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    res.status(201).json({ plan: await prisma.nfePlan.create({ data }) });
  } catch (e) { next(e); }
};

exports.updatePlan = async (req, res, next) => {
  try {
    const existing = await prisma.nfePlan.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Plano não encontrado.' });
    const { data, error } = parsePlan(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar.' });
    res.json({ plan: await prisma.nfePlan.update({ where: { id: existing.id }, data }) });
  } catch (e) { next(e); }
};

/** Plano com assinantes só é DESATIVADO (some da vitrine; quem já tem continua). Sem assinantes, é apagado. */
exports.deletePlan = async (req, res, next) => {
  try {
    const plan = await prisma.nfePlan.findUnique({ where: { id: req.params.id }, include: { _count: { select: { subscriptions: true } } } });
    if (!plan) return res.status(404).json({ error: 'Plano não encontrado.' });
    if (plan._count.subscriptions > 0) {
      await prisma.nfePlan.update({ where: { id: plan.id }, data: { isActive: false, isPublic: false } });
      return res.json({ deactivated: true });
    }
    await prisma.nfePlan.delete({ where: { id: plan.id } });
    res.json({ deleted: true });
  } catch (e) { next(e); }
};

exports.listSubscriptions = async (req, res, next) => {
  try {
    const rows = await prisma.nfeSubscription.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { plan: { select: { id: true, name: true, maxMonthlyNotes: true } }, account: { select: { id: true, name: true } } }
    });
    const now = Date.now();
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        accountName: r.account.name,
        plan: r.plan,
        endsAt: r.endsAt,
        recurring: Boolean(r.billingSubscriptionId),
        cancelledAt: r.cancelledAt,
        note: r.note,
        status: !r.endsAt || r.endsAt.getTime() > now ? 'ativa' : 'vencida'
      }))
    });
  } catch (e) { next(e); }
};

exports.grant = async (req, res, next) => {
  try {
    const { accountId, planId, months, endsAt, note } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'Escolha a conta.' });
    const sub = await nfe.adminGrant({ accountId, planId: planId || null, months, endsAt: endsAt === '' ? undefined : endsAt, note, actorEmail: req.member.email });
    res.json({ subscription: sub });
  } catch (e) { next(e); }
};

exports.revoke = async (req, res, next) => {
  try {
    res.json(await nfe.adminRevoke({ accountId: req.params.accountId, actorEmail: req.member.email }));
  } catch (e) { next(e); }
};
