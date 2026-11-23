// backend/src/services/nfe/nfeService.js
//
// Plano EXCLUSIVO do emissor de NF-e: assinatura própria (cobrança separada do plano do Turbo Prospect).
//   - O administrador cria os planos (preço, ciclo, notas/mês) em Administração > Notas fiscais.
//   - O cliente contrata em Notas Fiscais; o pagamento (Asaas) confirmado renova a assinatura.
//   - Vencida: o emissor fica em MODO CONSULTA (baixar XML/DANFE continua liberado, emitir não).
//   - Administrador da plataforma: acesso total, sem limite.
const prisma = require('../../config/db');
const env = require('../../config/env');
const asaas = require('../billing/asaasClient');
const { addMonths, CYCLE_BY_MONTHS } = require('../billing/billingService');
const { addLog, isPlatformAdminEmail } = require('../accessService');

const REF_PREFIX = 'nfe:';

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const todayBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

function serializePlan(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    cycleMonths: p.cycleMonths,
    maxMonthlyNotes: p.maxMonthlyNotes,
    isActive: p.isActive,
    isPublic: p.isPublic,
    sortOrder: p.sortOrder
  };
}

/**
 * Situação do emissor para uma conta.
 *  status: 'ativa' | 'vencida' (modo consulta) | 'sem_plano'
 *  limit:  notas de produção por mês (null = ilimitado)
 */
async function getState(accountId, { isPlatformAdmin = false } = {}) {
  if (isPlatformAdmin) {
    return { status: 'ativa', admin: true, plan: null, endsAt: null, limit: null, subscription: null };
  }
  const sub = await prisma.nfeSubscription.findUnique({ where: { accountId }, include: { plan: true } });
  if (!sub || (!sub.planId && !sub.endsAt && !sub.startsAt)) {
    return { status: 'sem_plano', plan: null, endsAt: null, limit: null, subscription: sub };
  }
  const now = Date.now();
  const graceMs = env.graceDays * 24 * 3600 * 1000;
  const active = !sub.cancelledAt || (sub.endsAt && sub.endsAt.getTime() > now);
  const notExpired = !sub.endsAt || sub.endsAt.getTime() + graceMs > now;
  const status = active && notExpired ? 'ativa' : 'vencida';
  return {
    status,
    plan: sub.plan ? serializePlan(sub.plan) : null,
    endsAt: sub.endsAt,
    limit: sub.plan?.maxMonthlyNotes ?? null,
    subscription: sub
  };
}

async function listPublicPlans() {
  const plans = await prisma.nfePlan.findMany({
    where: { isActive: true, isPublic: true },
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }]
  });
  return plans.map(serializePlan);
}

// ---------------------------------------------------------------- cobrança (Asaas)
async function checkout({ accountId, planId, cpfCnpj, actorEmail }) {
  if (!asaas.isEnabled()) {
    const err = new Error('A cobrança automática ainda não está ativada neste sistema. Fale com o suporte.');
    err.status = 503;
    throw err;
  }
  const plan = await prisma.nfePlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    const err = new Error('Plano de NF-e não encontrado ou indisponível.');
    err.status = 404;
    throw err;
  }
  if (!CYCLE_BY_MONTHS[plan.cycleMonths]) {
    const err = new Error('Este plano tem um ciclo de cobrança inválido.');
    err.status = 400;
    throw err;
  }
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { members: { select: { email: true, role: true }, orderBy: { createdAt: 'asc' } }, nfeSubscription: true }
  });
  if (!account) {
    const err = new Error('Conta não encontrada.');
    err.status = 404;
    throw err;
  }
  const digits = onlyDigits(cpfCnpj || account.taxId);
  if (![11, 14].includes(digits.length)) {
    const err = new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
    err.status = 400;
    throw err;
  }
  const sub = account.nfeSubscription;

  // Mesmo plano com assinatura recorrente em andamento: só reaproveita o link de pagamento.
  if (sub?.billingSubscriptionId && sub.planId === plan.id && !sub.cancelledAt) {
    return { payUrl: (await getPendingPaymentLink(sub))?.url || null, reused: true, plan: serializePlan(plan) };
  }
  if (sub?.billingSubscriptionId) {
    await asaas.deleteSubscription(sub.billingSubscriptionId).catch((e) => console.warn('NF-e: não cancelou assinatura anterior:', e.message));
  }

  const owner = account.members.find((m) => m.role === 'owner') || account.members[0];
  let customerId = account.billingCustomerId || sub?.billingCustomerId;
  if (!customerId) {
    const customer = await asaas.createCustomer({ name: account.name, email: owner?.email, cpfCnpj: digits, externalReference: account.id });
    customerId = customer.id;
  }
  const remote = await asaas.createSubscription({
    customer: customerId,
    billingType: 'UNDEFINED',
    value: plan.priceCents / 100,
    nextDueDate: todayBR(),
    cycle: CYCLE_BY_MONTHS[plan.cycleMonths],
    description: `${env.appName} — Emissor de NF-e, plano ${plan.name}`,
    externalReference: `${REF_PREFIX}${account.id}`
  });

  const data = { planId: plan.id, billingCustomerId: customerId, billingSubscriptionId: remote.id, cancelledAt: null };
  await prisma.nfeSubscription.upsert({
    where: { accountId },
    update: data,
    create: { accountId, ...data }
  });
  await addLog(accountId, 'nfe', `Assinatura de NF-e criada: plano ${plan.name} (${brl(plan.priceCents)} a cada ${plan.cycleMonths} mês/meses)`, actorEmail);
  const link = await getPendingPaymentLink({ billingSubscriptionId: remote.id });
  return { payUrl: link?.url || null, reused: false, plan: serializePlan(plan) };
}

async function getPendingPaymentLink(sub) {
  if (!asaas.isEnabled() || !sub?.billingSubscriptionId) return null;
  try {
    const data = await asaas.listSubscriptionPayments(sub.billingSubscriptionId);
    const open = (data.data || []).find((p) => ['PENDING', 'OVERDUE'].includes(p.status));
    return open ? { url: open.invoiceUrl || null, dueDate: open.dueDate || null, value: open.value ?? null } : null;
  } catch (err) {
    console.warn('NF-e: não consultou cobranças no Asaas:', err.message);
    return null;
  }
}

/** Cliente cancela a recorrência (o acesso vale até o fim do que já foi pago). */
async function cancelRecurring({ accountId, actorEmail }) {
  const sub = await prisma.nfeSubscription.findUnique({ where: { accountId } });
  if (!sub) return { cancelled: false };
  if (sub.billingSubscriptionId && asaas.isEnabled()) {
    await asaas.deleteSubscription(sub.billingSubscriptionId).catch((e) => console.warn('NF-e: não cancelou no Asaas:', e.message));
  }
  await prisma.nfeSubscription.update({ where: { accountId }, data: { billingSubscriptionId: null, cancelledAt: new Date() } });
  await addLog(accountId, 'nfe', 'Assinatura de NF-e cancelada (vale até o vencimento)', actorEmail);
  return { cancelled: true };
}

function isNfePayment(payment) {
  return String(payment?.externalReference || '').startsWith(REF_PREFIX);
}

async function findSubForPayment(payment) {
  if (payment.subscription) {
    const bySub = await prisma.nfeSubscription.findFirst({ where: { billingSubscriptionId: payment.subscription }, include: { plan: true } });
    if (bySub) return bySub;
  }
  const ref = String(payment.externalReference || '');
  if (ref.startsWith(REF_PREFIX)) {
    return prisma.nfeSubscription.findUnique({ where: { accountId: ref.slice(REF_PREFIX.length) }, include: { plan: true } });
  }
  return null;
}

/** true se este pagamento pertence a uma assinatura de NF-e (o webhook geral usa para não renovar o Turbo). */
async function ownsPayment(payment) {
  if (isNfePayment(payment)) return true;
  if (!payment?.subscription) return false;
  const found = await prisma.nfeSubscription.findFirst({ where: { billingSubscriptionId: payment.subscription }, select: { id: true } });
  return Boolean(found);
}

async function handleWebhookEvent(event, payment) {
  const sub = await findSubForPayment(payment);
  if (!sub) return { ignored: 'assinatura de NF-e não encontrada' };

  if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
    const existing = await prisma.nfePayment.findUnique({ where: { id: payment.id } });
    if (existing?.appliedAt) return { status: 'duplicate' };
    const months = sub.plan?.cycleMonths || 1;
    const now = new Date();
    const base = sub.endsAt && sub.endsAt.getTime() > now.getTime() ? sub.endsAt : now;
    const endsAt = addMonths(base, months);
    try {
      await prisma.$transaction([
        prisma.nfePayment.create({
          data: {
            id: payment.id,
            accountId: sub.accountId,
            status: payment.status || 'CONFIRMED',
            amountCents: Math.round(Number(payment.value || 0) * 100),
            paidAt: now,
            appliedAt: now,
            invoiceUrl: payment.invoiceUrl || null
          }
        }),
        prisma.nfeSubscription.update({ where: { id: sub.id }, data: { endsAt, startsAt: sub.startsAt || now, cancelledAt: null } })
      ]);
    } catch (err) {
      if (err?.code === 'P2002') return { status: 'duplicate' };
      throw err;
    }
    await addLog(sub.accountId, 'nfe', `Pagamento de NF-e ${brl(Math.round(Number(payment.value || 0) * 100))} recebido — vale até ${endsAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, 'Asaas');
    return { status: 'applied', endsAt };
  }
  if (event === 'PAYMENT_OVERDUE') await addLog(sub.accountId, 'nfe', `Cobrança de NF-e em atraso (venceu em ${payment.dueDate || '?'})`, 'Asaas');
  if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'].includes(event)) await addLog(sub.accountId, 'estorno', `NF-e: ${event} — pagamento ${payment.id}. Verifique a assinatura.`, 'Asaas');
  return { handled: event };
}

// ---------------------------------------------------------------- administrador
async function adminGrant({ accountId, planId, months, endsAt, note, actorEmail }) {
  const plan = planId ? await prisma.nfePlan.findUnique({ where: { id: planId } }) : null;
  if (planId && !plan) {
    const err = new Error('Plano de NF-e não encontrado.');
    err.status = 404;
    throw err;
  }
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) {
    const err = new Error('Conta não encontrada.');
    err.status = 404;
    throw err;
  }
  const current = await prisma.nfeSubscription.findUnique({ where: { accountId } });
  const now = new Date();
  let newEnd;
  if (endsAt === null || endsAt === 'none') newEnd = null; // cortesia sem vencimento
  else if (endsAt) newEnd = new Date(`${String(endsAt).slice(0, 10)}T23:59:59-03:00`);
  else {
    const base = current?.endsAt && current.endsAt.getTime() > now.getTime() ? current.endsAt : now;
    newEnd = addMonths(base, Math.max(1, Number(months) || plan?.cycleMonths || 1));
  }
  if (newEnd && Number.isNaN(newEnd.getTime())) {
    const err = new Error('Data de vencimento inválida.');
    err.status = 400;
    throw err;
  }
  const data = { planId: plan?.id ?? current?.planId ?? null, endsAt: newEnd, startsAt: current?.startsAt || now, cancelledAt: null, note: note || current?.note || null };
  const sub = await prisma.nfeSubscription.upsert({ where: { accountId }, update: data, create: { accountId, ...data } });
  await addLog(accountId, 'nfe', `NF-e liberada pelo administrador: ${plan?.name || 'plano atual'} até ${newEnd ? newEnd.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'sem vencimento'}`, actorEmail);
  return sub;
}

async function adminRevoke({ accountId, actorEmail }) {
  const sub = await prisma.nfeSubscription.findUnique({ where: { accountId } });
  if (!sub) return { revoked: false };
  if (sub.billingSubscriptionId && asaas.isEnabled()) {
    await asaas.deleteSubscription(sub.billingSubscriptionId).catch((e) => console.warn('NF-e: não cancelou no Asaas:', e.message));
  }
  await prisma.nfeSubscription.update({ where: { accountId }, data: { endsAt: new Date(Date.now() - 1000), billingSubscriptionId: null, cancelledAt: new Date() } });
  await addLog(accountId, 'nfe', 'NF-e encerrada pelo administrador (modo consulta)', actorEmail);
  return { revoked: true };
}

module.exports = {
  serializePlan,
  getState,
  listPublicPlans,
  checkout,
  cancelRecurring,
  getPendingPaymentLink,
  isNfePayment,
  ownsPayment,
  handleWebhookEvent,
  adminGrant,
  adminRevoke,
  isPlatformAdminEmail
};
