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
    storageMb: p.storageMb ?? null,
    isActive: p.isActive,
    isPublic: p.isPublic,
    sortOrder: p.sortOrder
  };
}

/** Fim do mês atual (horário de Brasília): quando acabam os pacotes de notas comprados neste mês. */
function endOfMonthBR(from = new Date()) {
  const [y, m] = from.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00-03:00`);
}

/** Pacotes avulsos pagos e ainda dentro da validade. */
async function activeAddons(accountId) {
  const rows = await prisma.nfeAddonPurchase.findMany({ where: { accountId, status: 'paid', expiresAt: { gt: new Date() } }, orderBy: { paidAt: 'desc' } });
  return {
    rows,
    extraNotes: rows.filter((r) => r.kind === 'notes').reduce((t, r) => t + r.amount, 0),
    extraStorageMb: rows.filter((r) => r.kind === 'storage').reduce((t, r) => t + r.amount, 0)
  };
}

/** Maior de dois limites, onde null = ilimitado. */
const bestLimit = (a, b) => (a === null || b === null ? null : Math.max(a, b));

/**
 * Situação do emissor para uma conta.
 *  status: 'ativa' | 'vencida' (modo consulta) | 'sem_plano'
 *  source: 'assinatura' (plano de NF-e próprio) | 'plano' (NF-e incluída no plano do app) | 'admin'
 *  limit:  notas de produção por mês, já somando pacotes (null = ilimitado)
 *  storageMb: espaço total para guardar notas, já somando pacotes (null = sem limite)
 */
async function getState(accountId, { isPlatformAdmin = false } = {}) {
  if (isPlatformAdmin) {
    return { status: 'ativa', source: 'admin', admin: true, plan: null, endsAt: null, limit: null, storageMb: null, subscription: null };
  }
  const [sub, account] = await Promise.all([
    prisma.nfeSubscription.findUnique({ where: { accountId }, include: { plan: true } }),
    prisma.account.findUnique({ where: { id: accountId }, include: { subscriptionPlan: true } })
  ]);
  const mainPlan = account?.subscriptionPlan || null;
  const includedInMainPlan = Boolean(mainPlan?.nfeIncluded);

  let subActive = false;
  if (sub && (sub.planId || sub.endsAt || sub.startsAt)) {
    const now = Date.now();
    const graceMs = env.graceDays * 24 * 3600 * 1000;
    const active = !sub.cancelledAt || (sub.endsAt && sub.endsAt.getTime() > now);
    const notExpired = !sub.endsAt || sub.endsAt.getTime() + graceMs > now;
    subActive = Boolean(active && notExpired);
  }
  const hasSubRecord = Boolean(sub && (sub.planId || sub.endsAt || sub.startsAt));

  let status;
  let source = null;
  let baseLimit = null;
  let baseStorage = null;
  if (subActive || includedInMainPlan) {
    status = 'ativa';
    const candidates = [];
    if (subActive) candidates.push({ limit: sub.plan?.maxMonthlyNotes ?? null, storage: sub.plan?.storageMb ?? env.nfe.storageBaseMb });
    if (includedInMainPlan) candidates.push({ limit: mainPlan.nfeMonthlyNotes ?? null, storage: mainPlan.nfeStorageMb ?? env.nfe.storageBaseMb });
    baseLimit = candidates.map((c) => c.limit).reduce(bestLimit);
    baseStorage = Math.max(...candidates.map((c) => c.storage));
    source = subActive ? 'assinatura' : 'plano';
  } else if (hasSubRecord) {
    status = 'vencida';
    baseLimit = sub.plan?.maxMonthlyNotes ?? null;
    baseStorage = sub.plan?.storageMb ?? env.nfe.storageBaseMb;
    source = 'assinatura';
  } else {
    return { status: 'sem_plano', plan: null, endsAt: null, limit: null, storageMb: null, subscription: sub };
  }

  const extras = await activeAddons(accountId);
  return {
    status,
    source,
    plan: sub?.plan && source === 'assinatura' ? serializePlan(sub.plan) : null,
    includedPlanName: includedInMainPlan ? mainPlan.name : null,
    endsAt: source === 'assinatura' ? sub?.endsAt ?? null : null,
    baseLimit,
    extraNotes: extras.extraNotes,
    limit: baseLimit === null ? null : baseLimit + extras.extraNotes,
    baseStorageMb: baseStorage,
    extraStorageMb: extras.extraStorageMb,
    storageMb: baseStorage + extras.extraStorageMb,
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
  const ref = String(payment?.externalReference || '');
  return ref.startsWith(REF_PREFIX) || ref.startsWith('nfeaddon:');
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
  if (isAddonPayment(payment)) {
    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') return applyAddonPaid(payment);
    return { handled: event, addon: true };
  }
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

// ---------------------------------------------------------------- pacotes avulsos (notas e espaço)
const ADDON_REF = 'nfeaddon:';

function serializeAddon(a) {
  return { id: a.id, kind: a.kind, name: a.name, description: a.description, amount: a.amount, priceCents: a.priceCents, validMonths: a.validMonths, isActive: a.isActive, sortOrder: a.sortOrder };
}

async function listPublicAddons() {
  const rows = await prisma.nfeAddon.findMany({ where: { isActive: true }, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { priceCents: 'asc' }] });
  return rows.map(serializeAddon);
}

async function listMyAddons(accountId) {
  const rows = await prisma.nfeAddonPurchase.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: 30 });
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, kind: r.kind, name: r.name, amount: r.amount, priceCents: r.priceCents, status: r.status, paidAt: r.paidAt, expiresAt: r.expiresAt,
    active: r.status === 'paid' && Boolean(r.expiresAt) && r.expiresAt.getTime() > now,
    payUrl: r.status === 'pending' ? r.invoiceUrl : null
  }));
}

/** Cria a cobrança avulsa (Asaas) de um pacote. O pacote só passa a valer quando o pagamento é confirmado. */
async function checkoutAddon({ accountId, addonId, cpfCnpj, actorEmail }) {
  if (!asaas.isEnabled()) {
    const err = new Error('A cobrança automática ainda não está ativada neste sistema. Fale com o suporte.');
    err.status = 503;
    throw err;
  }
  const addon = await prisma.nfeAddon.findUnique({ where: { id: addonId } });
  if (!addon || !addon.isActive) {
    const err = new Error('Pacote não encontrado ou indisponível.');
    err.status = 404;
    throw err;
  }
  const state = await getState(accountId);
  if (state.status === 'sem_plano') {
    const err = new Error('Contrate um plano de NF-e (ou um plano do app com NF-e incluída) antes de comprar pacotes.');
    err.status = 403;
    throw err;
  }
  const account = await prisma.account.findUnique({ where: { id: accountId }, include: { members: { select: { email: true, role: true }, orderBy: { createdAt: 'asc' } } } });
  if (!account) {
    const err = new Error('Conta não encontrada.');
    err.status = 404;
    throw err;
  }
  let customerId = account.billingCustomerId;
  if (!customerId) {
    const digits = onlyDigits(cpfCnpj || account.taxId);
    if (![11, 14].includes(digits.length)) {
      const err = new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
      err.status = 400;
      throw err;
    }
    const owner = account.members.find((m) => m.role === 'owner') || account.members[0];
    const customer = await asaas.createCustomer({ name: account.name, email: owner?.email, cpfCnpj: digits, externalReference: account.id });
    customerId = customer.id;
    await prisma.account.update({ where: { id: account.id }, data: { billingProvider: account.billingProvider || 'asaas', billingCustomerId: customerId } });
  }
  const purchase = await prisma.nfeAddonPurchase.create({
    data: { accountId, addonId: addon.id, kind: addon.kind, name: addon.name, amount: addon.amount, priceCents: addon.priceCents }
  });
  try {
    const pay = await asaas.createPayment({
      customer: customerId,
      billingType: 'UNDEFINED',
      value: addon.priceCents / 100,
      dueDate: todayBR(),
      description: `${env.appName} — NF-e: ${addon.name}`,
      externalReference: `${ADDON_REF}${purchase.id}`
    });
    await prisma.nfeAddonPurchase.update({ where: { id: purchase.id }, data: { asaasPaymentId: pay.id, invoiceUrl: pay.invoiceUrl || null } });
    await addLog(accountId, 'nfe', `Pacote de NF-e pedido: ${addon.name} (${brl(addon.priceCents)})`, actorEmail);
    return { id: purchase.id, payUrl: pay.invoiceUrl || null };
  } catch (e) {
    await prisma.nfeAddonPurchase.update({ where: { id: purchase.id }, data: { status: 'cancelled' } }).catch(() => null);
    throw e;
  }
}

const isAddonPayment = (payment) => String(payment?.externalReference || '').startsWith(ADDON_REF);

/** Pagamento do pacote confirmado: libera uma única vez (mesmo que o Asaas avise duas vezes). */
async function applyAddonPaid(payment) {
  const id = String(payment.externalReference).slice(ADDON_REF.length);
  const purchase = await prisma.nfeAddonPurchase.findUnique({ where: { id }, include: { addon: true } });
  if (!purchase) return { status: 'ignored', reason: 'pacote não encontrado' };
  if (purchase.status === 'paid') return { status: 'duplicate' };
  const paidCents = Math.round(Number(payment.value || 0) * 100);
  if (paidCents < purchase.priceCents) return { status: 'ignored', reason: 'valor pago menor que o pedido' };
  const now = new Date();
  const expiresAt = purchase.kind === 'notes' ? endOfMonthBR(now) : addMonths(now, Math.max(1, purchase.addon?.validMonths || 12));
  const claimed = await prisma.nfeAddonPurchase.updateMany({
    where: { id, status: { not: 'paid' } },
    data: { status: 'paid', paidAt: now, expiresAt, asaasPaymentId: payment.id }
  });
  if (!claimed.count) return { status: 'duplicate' };
  await addLog(purchase.accountId, 'nfe', `Pacote de NF-e liberado: ${purchase.name} — vale até ${expiresAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, 'Asaas');
  return { status: 'applied', expiresAt };
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
  serializeAddon,
  listPublicAddons,
  listMyAddons,
  checkoutAddon,
  applyAddonPaid,
  endOfMonthBR,
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
