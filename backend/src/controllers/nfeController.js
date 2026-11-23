// backend/src/controllers/nfeController.js
//
// Área do CLIENTE do emissor de NF-e: ver planos e a situação, contratar/cancelar e abrir o emissor.
const prisma = require('../config/db');
const env = require('../config/env');
const asaas = require('../services/billing/asaasClient');
const nfe = require('../services/nfe/nfeService');
const bridge = require('../services/nfe/nfeBridge');

const isManager = (req) => ['owner', 'admin'].includes(req.memberRole);

exports.status = async (req, res, next) => {
  try {
    const state = await nfe.getState(req.userId, { isPlatformAdmin: req.isPlatformAdmin });
    const [plans, payments, account] = await Promise.all([
      nfe.listPublicPlans(),
      prisma.nfePayment.findMany({ where: { accountId: req.userId }, orderBy: { createdAt: 'desc' }, take: 12 }),
      prisma.account.findUnique({ where: { id: req.userId }, select: { taxId: true } })
    ]);
    const pending = state.subscription ? await nfe.getPendingPaymentLink(state.subscription) : null;

    let usage = null;
    if (env.nfe.secret && state.status !== 'sem_plano') {
      usage = await bridge.pyGetJson('/_uso', {
        accountId: req.userId, userEmail: req.member.email, role: req.memberRole, limit: state.limit, readOnly: state.status === 'vencida'
      });
    }

    res.json({
      configured: Boolean(env.nfe.secret),
      billingEnabled: asaas.isEnabled(),
      canManage: isManager(req),
      status: state.status, // ativa | vencida | sem_plano
      isPlatformAdmin: Boolean(state.admin),
      plan: state.plan,
      endsAt: state.endsAt,
      limit: state.limit,
      hasRecurring: Boolean(state.subscription?.billingSubscriptionId),
      plans,
      pendingPayment: pending,
      usage,
      taxId: account?.taxId || null,
      supportContact: env.supportContact || null,
      payments: payments.map((p) => ({ id: p.id, amountCents: p.amountCents, paidAt: p.paidAt, status: p.status, invoiceUrl: p.invoiceUrl }))
    });
  } catch (error) {
    next(error);
  }
};

exports.checkout = async (req, res, next) => {
  try {
    if (!isManager(req)) return res.status(403).json({ error: 'Só o proprietário ou administrador da conta pode contratar.' });
    const { planId, cpfCnpj } = req.body || {};
    if (!planId) return res.status(400).json({ error: 'Escolha um plano.' });
    const result = await nfe.checkout({ accountId: req.userId, planId, cpfCnpj, actorEmail: req.member.email });
    res.json({ payUrl: result.payUrl, reused: result.reused });
  } catch (error) {
    next(error);
  }
};

exports.cancel = async (req, res, next) => {
  try {
    if (!isManager(req)) return res.status(403).json({ error: 'Só o proprietário ou administrador da conta pode cancelar.' });
    res.json(await nfe.cancelRecurring({ accountId: req.userId, actorEmail: req.member.email }));
  } catch (error) {
    next(error);
  }
};

/** Ticket de entrada: o navegador abre /nfe-app/entrar?t=... e ganha o cookie da aba. */
exports.session = async (req, res, next) => {
  try {
    if (!env.nfe.secret) return res.status(503).json({ error: 'O emissor de NF-e ainda não foi ligado neste servidor. Fale com o administrador.' });
    if (!isManager(req)) return res.status(403).json({ error: 'Só o proprietário ou administradores da conta acessam as Notas Fiscais.' });
    const state = await nfe.getState(req.userId, { isPlatformAdmin: req.isPlatformAdmin });
    if (state.status === 'sem_plano') return res.status(403).json({ error: 'Contrate um plano de NF-e para usar o emissor.', code: 'NFE_NO_PLAN' });
    const t = bridge.signToken('t', { a: req.userId, m: req.memberId }, 120);
    res.json({ url: `${env.nfe.prefix}/entrar?t=${encodeURIComponent(t)}`, readOnly: state.status === 'vencida' });
  } catch (error) {
    next(error);
  }
};
