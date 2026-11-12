// backend/src/services/walletTopupService.js
// Recarga de saldo comprada pelo próprio cliente: cobrança avulsa no Asaas (Pix, boleto ou cartão).
// Quando o pagamento é confirmado (webhook), o saldo cai na carteira sozinho e a mensalidade de número em atraso é regularizada.
const prisma = require('../config/db');
const asaas = require('./billing/asaasClient');
const wallet = require('./walletService');
const rules = require('./platformBillingSettings');

const TAG = 'topup:';
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const todayBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function config() {
  const r = await rules.get();
  return { enabled: r.topupEnabled && asaas.isEnabled(), minBrl: r.topupMinBrl, maxBrl: r.topupMaxBrl, asaas: asaas.isEnabled() };
}

async function createTopup({ accountId, amountBrl, cpfCnpj }) {
  const cfg = await config();
  if (!asaas.isEnabled()) throw fail(503, 'A cobrança automática (Asaas) ainda não está ativada neste sistema. Peça a recarga ao administrador.');
  if (!cfg.enabled) throw fail(403, 'A recarga pelo cliente está desligada pelo administrador.');
  const value = Math.round(Number(String(amountBrl).replace(',', '.')) * 100) / 100;
  if (!Number.isFinite(value) || value < cfg.minBrl || value > cfg.maxBrl) throw fail(400, `Informe um valor entre R$ ${cfg.minBrl.toFixed(2)} e R$ ${cfg.maxBrl.toFixed(2)}.`);
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw fail(404, 'Conta não encontrada.');
  const owner = await prisma.member.findFirst({ where: { accountId, role: 'owner' }, select: { email: true } });
  let customerId = account.billingCustomerId;
  if (!customerId) {
    const digits = onlyDigits(cpfCnpj);
    if (![11, 14].includes(digits.length)) throw fail(400, 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
    const customer = await asaas.createCustomer({ name: account.name, email: owner?.email, cpfCnpj: digits, externalReference: account.id });
    customerId = customer.id;
    await prisma.account.update({ where: { id: account.id }, data: { billingProvider: account.billingProvider || 'asaas', billingCustomerId: customerId } });
  }
  const topup = await prisma.walletTopup.create({ data: { accountId, amountCents: Math.round(value * 100), status: 'pending' } });
  try {
    const pay = await asaas.createPayment({
      customer: customerId, billingType: 'UNDEFINED', value, dueDate: todayBR(),
      description: `Recarga de saldo — R$ ${value.toFixed(2)}`, externalReference: `${TAG}${topup.id}`
    });
    await prisma.walletTopup.update({ where: { id: topup.id }, data: { asaasPaymentId: pay.id, invoiceUrl: pay.invoiceUrl || null } });
    return { id: topup.id, payUrl: pay.invoiceUrl || null, amountBrl: value };
  } catch (e) {
    await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: 'cancelled' } }).catch(() => null);
    throw e;
  }
}

const isTopupPayment = (payment) => String(payment?.externalReference || '').startsWith(TAG);

/** Pagamento confirmado: credita uma única vez (mesmo que o Asaas avise duas vezes). */
async function applyPaid(payment) {
  const id = String(payment.externalReference).slice(TAG.length);
  const topup = await prisma.walletTopup.findUnique({ where: { id } });
  if (!topup) return { status: 'ignored', reason: 'recarga não encontrada' };
  if (topup.status === 'paid') return { status: 'duplicate' };
  const paidCents = Math.round(Number(payment.value || 0) * 100);
  if (paidCents < topup.amountCents) return { status: 'ignored', reason: 'valor pago menor que o pedido' };
  const claimed = await prisma.walletTopup.updateMany({ where: { id, status: { not: 'paid' } }, data: { status: 'paid', paidAt: new Date(), asaasPaymentId: payment.id } });
  if (!claimed.count) return { status: 'duplicate' };
  const amount = topup.amountCents / 100;
  await wallet.credit(topup.accountId, amount, { type: 'recarga', description: topup.source === 'auto' ? 'Recarga automática (cartão)' : 'Recarga online (Asaas)', refId: topup.id });
  if (topup.source !== 'auto') await require('./autoRechargeService').captureToken(topup.accountId, payment);
  const r = await rules.get();
  if (r.topupAutoEnable) await prisma.wallet.updateMany({ where: { userId: topup.accountId, enabled: { not: true } }, data: { enabled: true } });
  await prisma.wallet.updateMany({ where: { userId: topup.accountId }, data: { lowNotifiedAt: null } });
  // regulariza mensalidade de número em atraso (e reativa o número)
  require('../jobs/didJob').runBillingNow().catch((e) => console.warn('Mensalidade após recarga:', e.message));
  return { status: 'applied', amountBrl: amount };
}

async function listTopups(accountId) {
  const rows = await prisma.walletTopup.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: 30 });
  return rows.map((t) => ({ id: t.id, amountBrl: t.amountCents / 100, status: t.status, createdAt: t.createdAt, paidAt: t.paidAt, payUrl: t.status === 'pending' ? t.invoiceUrl : null }));
}

module.exports = { config, createTopup, isTopupPayment, applyPaid, listTopups };
