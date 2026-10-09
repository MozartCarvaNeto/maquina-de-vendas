// backend/src/services/billing/billingService.js
//
// Cobrança automática: cria a assinatura recorrente no Asaas e, quando o
// pagamento é confirmado (webhook), renova o acesso da conta sozinho.
//
// Fluxo:  cliente escolhe plano -> checkout() cria cliente+assinatura no Asaas ->
//         cliente paga (PIX/boleto/cartão) -> Asaas avisa o webhook ->
//         handleWebhook() -> applyPayment() soma o ciclo do plano ao vencimento.
// Atrasou?  Nada a fazer: o vencimento passa e o bloqueio por data é automático
//           (use GRACE_DAYS para dar alguns dias de tolerância).
const crypto = require('crypto');
const prisma = require('../../config/db');
const env = require('../../config/env');
const asaas = require('./asaasClient');
const { addLog, resumeAccountSessions } = require('../accessService');

const CYCLE_BY_MONTHS = { 1: 'MONTHLY', 3: 'QUARTERLY', 6: 'SEMIANNUALLY', 12: 'YEARLY' };

function isEnabled() {
  return asaas.isEnabled();
}

/** Soma meses de calendário (31/jan + 1 mês = 28/fev), sem "andar" de dia. */
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function formatBR(date) {
  return new Date(date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function brl(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function loadAccountForBilling(accountId) {
  return prisma.account.findUnique({
    where: { id: accountId },
    include: {
      subscriptionPlan: true,
      members: { select: { id: true, name: true, email: true, role: true }, orderBy: { createdAt: 'asc' } }
    }
  });
}

/** Link de pagamento da cobrança em aberto (PIX/boleto/cartão), se houver. */
async function getPendingPaymentLink(account) {
  if (!isEnabled() || !account.billingSubscriptionId) return null;
  try {
    const data = await asaas.listSubscriptionPayments(account.billingSubscriptionId);
    const open = (data.data || []).find((p) => ['PENDING', 'OVERDUE'].includes(p.status));
    return open ? { url: open.invoiceUrl || null, dueDate: open.dueDate || null, value: open.value ?? null } : null;
  } catch (err) {
    console.warn('Não foi possível consultar cobranças no Asaas:', err.message);
    return null;
  }
}

/**
 * Cria (ou troca) a assinatura recorrente do plano e devolve o link para pagar.
 * NÃO libera o acesso: quem libera é o pagamento confirmado (webhook).
 */
async function checkout({ accountId, planId, cpfCnpj, actorEmail }) {
  if (!isEnabled()) {
    const err = new Error('A cobrança automática ainda não está ativada neste sistema.');
    err.status = 503;
    throw err;
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    const err = new Error('Plano não encontrado ou indisponível.');
    err.status = 404;
    throw err;
  }
  if (!CYCLE_BY_MONTHS[plan.cycleMonths]) {
    const err = new Error('Este plano tem um ciclo de cobrança inválido.');
    err.status = 400;
    throw err;
  }

  const digits = onlyDigits(cpfCnpj);
  if (![11, 14].includes(digits.length)) {
    const err = new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
    err.status = 400;
    throw err;
  }

  const account = await loadAccountForBilling(accountId);
  if (!account) {
    const err = new Error('Conta não encontrada.');
    err.status = 404;
    throw err;
  }
  const owner = account.members.find((m) => m.role === 'owner') || account.members[0];

  // Mesma assinatura do mesmo plano ainda ativa: só reaproveita o link.
  if (account.billingSubscriptionId && account.planId === plan.id) {
    const link = await getPendingPaymentLink(account);
    return { payUrl: link?.url || null, reused: true, plan };
  }

  // Trocou de plano: encerra a assinatura antiga para não cobrar duas vezes.
  if (account.billingSubscriptionId) {
    await asaas.deleteSubscription(account.billingSubscriptionId).catch((err) =>
      console.warn('Não foi possível cancelar a assinatura anterior:', err.message)
    );
  }

  let customerId = account.billingCustomerId;
  if (!customerId) {
    const customer = await asaas.createCustomer({
      name: account.name,
      email: owner?.email,
      cpfCnpj: digits,
      externalReference: account.id
    });
    customerId = customer.id;
  }

  const subscription = await asaas.createSubscription({
    customer: customerId,
    billingType: 'UNDEFINED', // o cliente escolhe PIX, boleto ou cartão na página de pagamento
    value: plan.priceCents / 100,
    nextDueDate: todayBR(),
    cycle: CYCLE_BY_MONTHS[plan.cycleMonths],
    description: `${env.appName} — plano ${plan.name}`,
    externalReference: account.id
  });

  await prisma.account.update({
    where: { id: account.id },
    data: {
      planId: plan.id,
      plan: plan.name,
      billingProvider: 'asaas',
      billingCustomerId: customerId,
      billingSubscriptionId: subscription.id
    }
  });
  await addLog(account.id, 'cobranca', `Assinatura criada: plano ${plan.name} (${brl(plan.priceCents)} a cada ${plan.cycleMonths} mês/meses)`, actorEmail);

  const link = await getPendingPaymentLink({ ...account, billingSubscriptionId: subscription.id });
  return { payUrl: link?.url || null, reused: false, plan };
}

async function cancelSubscription({ accountId, actorEmail }) {
  const account = await loadAccountForBilling(accountId);
  if (!account?.billingSubscriptionId) return { cancelled: false };
  if (isEnabled()) {
    await asaas.deleteSubscription(account.billingSubscriptionId).catch((err) =>
      console.warn('Não foi possível cancelar no Asaas:', err.message)
    );
  }
  await prisma.account.update({ where: { id: accountId }, data: { billingSubscriptionId: null } });
  await addLog(accountId, 'cobranca', 'Assinatura recorrente cancelada (o acesso continua até o vencimento)', actorEmail);
  return { cancelled: true };
}

/** Pagamento confirmado -> soma o ciclo do plano ao vencimento (uma única vez por pagamento). */
async function applyPayment(account, payment) {
  const existing = await prisma.billingPayment.findUnique({ where: { id: payment.id } });
  if (existing?.appliedAt) return { status: 'duplicate' };

  const months = account.subscriptionPlan?.cycleMonths || 1;
  const now = new Date();
  const current = account.subscriptionEndsAt ? new Date(account.subscriptionEndsAt) : null;
  const base = current && current.getTime() > now.getTime() ? current : now;
  const newEnd = addMonths(base, months);

  const wasBlocked = account.accessStatus === 'bloqueada';
  const wasPending = account.accessStatus === 'pendente';
  const activatePending = wasPending && env.autoActivateOnPayment;

  const accountData = {
    subscriptionEndsAt: newEnd,
    subscriptionStartsAt: account.subscriptionStartsAt || now,
    // Bloqueio MANUAL do administrador nunca é desfeito por pagamento.
    ...(wasBlocked ? {} : wasPending ? (activatePending ? { accessStatus: 'ativa' } : {}) : { accessStatus: 'ativa' })
  };

  try {
    await prisma.$transaction([
      prisma.billingPayment.create({
        data: {
          id: payment.id,
          accountId: account.id,
          provider: 'asaas',
          status: payment.status || 'CONFIRMED',
          amountCents: Math.round(Number(payment.value || 0) * 100),
          dueDate: payment.dueDate ? new Date(`${payment.dueDate}T12:00:00-03:00`) : null,
          paidAt: now,
          appliedAt: now,
          invoiceUrl: payment.invoiceUrl || null
        }
      }),
      prisma.account.update({ where: { id: account.id }, data: accountData })
    ]);
  } catch (err) {
    // Outro aviso do MESMO pagamento chegou ao mesmo tempo e já renovou.
    if (err?.code === 'P2002') return { status: 'duplicate' };
    throw err;
  }

  await addLog(
    account.id,
    'pagamento',
    `Pagamento ${brl(Math.round(Number(payment.value || 0) * 100))} recebido — acesso até ${formatBR(newEnd)}` +
      (wasBlocked ? ' (conta continua BLOQUEADA manualmente)' : wasPending && !activatePending ? ' (cadastro continua aguardando aprovação)' : ''),
    'Asaas'
  );

  if (!wasBlocked && (!wasPending || activatePending)) {
    await resumeAccountSessions(account.id).catch(() => null);
  }
  return { status: 'applied', endsAt: newEnd };
}

function tokenMatches(received) {
  const expected = env.asaas.webhookToken;
  if (!expected || !received) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findAccountForPayment(payment) {
  const include = {
    subscriptionPlan: true,
    members: { select: { email: true } }
  };
  if (payment.subscription) {
    const byApproved = await prisma.account.findFirst({ where: { billingSubscriptionId: payment.subscription }, include });
    if (byApproved) return byApproved;
  }
  if (payment.customer) {
    const byCustomer = await prisma.account.findFirst({ where: { billingCustomerId: payment.customer }, include });
    if (byCustomer) return byCustomer;
  }
  if (payment.externalReference) {
    return prisma.account.findUnique({ where: { id: payment.externalReference }, include });
  }
  return null;
}

/**
 * @returns {{http:number, body:object}}
 * Responde 200 para tudo que não é erro nosso (o Asaas pausa o envio de avisos
 * se o endereço devolver erro várias vezes).
 */
async function handleWebhook(headers, body) {
  if (!tokenMatches(headers['asaas-access-token'])) {
    return { http: 401, body: { error: 'Token inválido' } };
  }

  const event = body?.event;
  const payment = body?.payment;
  if (!event || !payment?.id) return { http: 200, body: { ignored: true } };

  const account = await findAccountForPayment(payment);
  if (!account) {
    console.warn(`Webhook Asaas (${event}) sem conta correspondente — pagamento ${payment.id}`);
    return { http: 200, body: { ignored: 'conta não encontrada' } };
  }

  if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
    const result = await applyPayment(account, payment);
    return { http: 200, body: result };
  }

  if (event === 'PAYMENT_OVERDUE') {
    await addLog(account.id, 'cobranca', `Cobrança em atraso (venceu em ${payment.dueDate || '?'})`, 'Asaas');
  } else if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'].includes(event)) {
    await addLog(account.id, 'estorno', `${event} — pagamento ${payment.id}. Verifique se deve bloquear a conta.`, 'Asaas');
  }
  return { http: 200, body: { handled: event } };
}

module.exports = {
  CYCLE_BY_MONTHS,
  isEnabled,
  addMonths,
  checkout,
  cancelSubscription,
  getPendingPaymentLink,
  applyPayment,
  handleWebhook,
  loadAccountForBilling
};
