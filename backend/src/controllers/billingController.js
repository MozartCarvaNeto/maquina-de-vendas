// backend/src/controllers/billingController.js
//
// Área do CLIENTE: ver o plano, o uso, escolher plano e pagar. Também recebe o
// aviso automático de pagamento do Asaas (webhook).
const prisma = require('../config/db');
const env = require('../config/env');
const billing = require('../services/billing/billingService');
const { computeAccess } = require('../services/accessService');
const { getAccountLimits, getUsage } = require('../services/planService');
const { catalog, planFeatureList } = require('../services/featureService');

function serializePlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceCents: plan.priceCents,
    cycleMonths: plan.cycleMonths,
    maxWhatsappConnections: plan.maxWhatsappConnections,
    maxMembers: plan.maxMembers,
    maxMonthlyMessages: plan.maxMonthlyMessages,
    // null = todas as funcionalidades; senão, lista de módulos incluídos.
    features: planFeatureList(plan)
  };
}

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }]
    });
    res.json({ plans: plans.map(serializePlan), billingEnabled: billing.isEnabled(), featureCatalog: catalog() });
  } catch (error) {
    next(error);
  }
};

exports.status = async (req, res, next) => {
  try {
    const account = await billing.loadAccountForBilling(req.userId);
    const access = req.access || computeAccess(account);
    const [limits, usage, payUrl, payments] = await Promise.all([
      getAccountLimits(req.userId),
      getUsage(req.userId),
      billing.getPendingPaymentLink(account),
      prisma.billingPayment.findMany({ where: { accountId: req.userId }, orderBy: { createdAt: 'desc' }, take: 12 })
    ]);

    res.json({
      billingEnabled: billing.isEnabled(),
      canManage: ['owner', 'admin'].includes(req.memberRole),
      account: { name: account.name, status: access.status, allowed: access.allowed, endsAt: access.endsAt, daysLeft: access.daysLeft },
      plan: account.subscriptionPlan ? serializePlan(account.subscriptionPlan) : null,
      hasSubscription: Boolean(account.billingSubscriptionId),
      limits,
      usage,
      features: req.features, // null = todos
      featureCatalog: catalog(),
      pendingPayment: payUrl,
      supportContact: env.supportContact || null,
      payments: payments.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        paidAt: p.paidAt,
        status: p.status,
        invoiceUrl: p.invoiceUrl
      }))
    });
  } catch (error) {
    next(error);
  }
};

exports.checkout = async (req, res, next) => {
  try {
    if (!['owner', 'admin'].includes(req.memberRole)) {
      return res.status(403).json({ error: 'Só o proprietário ou administrador da conta pode contratar um plano.' });
    }
    const { planId, cpfCnpj } = req.body;
    if (!planId) return res.status(400).json({ error: 'Escolha um plano.' });

    const result = await billing.checkout({
      accountId: req.userId,
      planId,
      cpfCnpj,
      actorEmail: req.member.email
    });
    res.json({ payUrl: result.payUrl, reused: result.reused });
  } catch (error) {
    next(error);
  }
};

exports.cancel = async (req, res, next) => {
  try {
    if (!['owner', 'admin'].includes(req.memberRole)) {
      return res.status(403).json({ error: 'Só o proprietário ou administrador da conta pode cancelar.' });
    }
    res.json(await billing.cancelSubscription({ accountId: req.userId, actorEmail: req.member.email }));
  } catch (error) {
    next(error);
  }
};

/** Rota PÚBLICA chamada pelo Asaas. A autenticação é o token no cabeçalho. */
exports.asaasWebhook = async (req, res) => {
  try {
    const { http, body } = await billing.handleWebhook(req.headers, req.body);
    res.status(http).json(body);
  } catch (error) {
    console.error('❌ Erro ao processar webhook do Asaas:', error);
    res.status(500).json({ error: 'Erro ao processar' }); // o Asaas tentará de novo
  }
};

/** Configurações públicas (tela de login/cadastro). Nada sensível. */
exports.publicConfig = (req, res) => {
  res.json({
    appName: env.appName,
    registrationMode: env.registrationMode,
    supportContact: env.supportContact || null,
    billingEnabled: billing.isEnabled()
  });
};

