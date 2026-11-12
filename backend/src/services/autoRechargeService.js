// backend/src/services/autoRechargeService.js
// Recarga automática: quando o saldo cai abaixo do limite, cobra no cartão salvo (token do Asaas).
// O cartão NUNCA passa pelo nosso servidor: o cliente paga uma recarga normal na página do Asaas;
// se pagou com cartão, o Asaas devolve um "token" (sem o número) que guardamos junto com bandeira e 4 últimos dígitos.
const prisma = require('../config/db');
const asaas = require('./billing/asaasClient');

const MIN_INTERVAL_MS = 60 * 60 * 1000; // no máximo 1 cobrança automática por hora
const MAX_PER_DAY = 3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const todayBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function status(accountId) {
  const w = await prisma.wallet.findUnique({ where: { userId: accountId } });
  return {
    available: asaas.isEnabled(),
    hasCard: !!w?.autoCardToken,
    card: w?.autoCardToken ? { brand: w.autoCardBrand || 'Cartão', last4: w.autoCardLast4 || '' } : null,
    enabled: !!(w?.autoRechargeEnabled && w?.autoCardToken),
    thresholdBrl: w?.autoRechargeThresholdBrl ?? 20,
    amountBrl: w?.autoRechargeAmountBrl ?? 50,
    lastAt: w?.autoRechargeLastAt || null,
    failedAt: w?.autoRechargeFailedAt || null
  };
}

async function configure(accountId, { enabled, thresholdBrl, amountBrl }, ip) {
  const w = await prisma.wallet.findUnique({ where: { userId: accountId } });
  if (!w) throw fail(400, 'Ative o saldo pré-pago antes.');
  const cfg = await require('./walletTopupService').config();
  const th = Number(String(thresholdBrl).replace(',', '.'));
  const am = Number(String(amountBrl).replace(',', '.'));
  if (!(th > 0) || !(am >= cfg.minBrl && am <= cfg.maxBrl)) {
    throw fail(400, `Informe um limite maior que zero e um valor de recarga entre R$ ${cfg.minBrl.toFixed(2)} e R$ ${cfg.maxBrl.toFixed(2)}.`);
  }
  if (enabled && !w.autoCardToken) {
    throw fail(400, 'Nenhum cartão salvo ainda. Faça uma recarga paga com cartão primeiro: o cartão fica guardado com segurança no Asaas.');
  }
  await prisma.wallet.update({
    where: { userId: accountId },
    data: {
      autoRechargeEnabled: !!enabled, autoRechargeThresholdBrl: th, autoRechargeAmountBrl: am,
      autoRechargeFailedAt: null, ...(enabled ? { autoRemoteIp: String(ip || '').replace('::ffff:', '').slice(0, 60) } : {})
    }
  });
  return status(accountId);
}

async function removeCard(accountId) {
  await prisma.wallet.updateMany({
    where: { userId: accountId },
    data: { autoCardToken: null, autoCardBrand: null, autoCardLast4: null, autoRechargeEnabled: false }
  });
  return status(accountId);
}

/** Chamado quando uma recarga é paga: se foi com cartão, guarda o token. Nunca lança erro. */
async function captureToken(accountId, payment) {
  try {
    let cc = payment?.creditCard;
    if (!cc?.creditCardToken && payment?.id && asaas.isEnabled()) {
      cc = (await asaas.getPayment(payment.id))?.creditCard;
    }
    if (!cc?.creditCardToken) return false;
    await prisma.wallet.updateMany({
      where: { userId: accountId },
      data: { autoCardToken: cc.creditCardToken, autoCardBrand: cc.creditCardBrand || null, autoCardLast4: cc.creditCardNumber ? String(cc.creditCardNumber).slice(-4) : null }
    });
    return true;
  } catch (e) {
    console.warn('Token de cartão não guardado:', e.message);
    return false;
  }
}

async function notifyFailure(accountId, reason) {
  try {
    const owner = await prisma.member.findFirst({ where: { accountId, role: 'owner' }, select: { email: true, name: true } });
    if (!owner?.email) return;
    const mailer = require('./email/systemMailer');
    const env = require('../config/env');
    const html = mailer.buildActionEmail({
      greeting: `Olá${owner.name ? `, ${owner.name}` : ''}!`,
      intro: `Não conseguimos fazer a recarga automática no seu cartão (${reason}). Desligamos a recarga automática para evitar novas tentativas. Recarregue manualmente ou atualize o cartão para religar.`,
      buttonText: 'Abrir meu saldo', url: `${(env.frontendUrl || '').replace(/\/$/, '')}/gateway`, footer: ''
    });
    await mailer.sendSystemEmail({ to: owner.email, subject: `Recarga automática falhou — ${env.appName}`, html, accountId });
  } catch (_) { /* aviso é só cortesia */ }
}

async function chargeOne(w) {
  // "reserva" a cobrança antes de chamar o Asaas: dois ciclos nunca cobram duas vezes
  const claimed = await prisma.wallet.updateMany({
    where: { userId: w.userId, OR: [{ autoRechargeLastAt: null }, { autoRechargeLastAt: { lt: new Date(Date.now() - MIN_INTERVAL_MS) } }] },
    data: { autoRechargeLastAt: new Date() }
  });
  if (!claimed.count) return null;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const today = await prisma.walletTopup.count({ where: { accountId: w.userId, source: 'auto', createdAt: { gte: since } } });
  if (today >= MAX_PER_DAY) return null;

  const account = await prisma.account.findUnique({ where: { id: w.userId } });
  const value = Math.round(w.autoRechargeAmountBrl * 100) / 100;
  const topup = await prisma.walletTopup.create({ data: { accountId: w.userId, amountCents: Math.round(value * 100), status: 'pending', source: 'auto' } });
  try {
    if (!account?.billingCustomerId) throw new Error('cliente sem cadastro no Asaas');
    const pay = await asaas.createPayment({
      customer: account.billingCustomerId, billingType: 'CREDIT_CARD', value, dueDate: todayBR(),
      description: `Recarga automática — R$ ${value.toFixed(2)}`, externalReference: `topup:${topup.id}`,
      creditCardToken: w.autoCardToken, remoteIp: w.autoRemoteIp || '127.0.0.1'
    });
    await prisma.walletTopup.update({ where: { id: topup.id }, data: { asaasPaymentId: pay.id, invoiceUrl: pay.invoiceUrl || null } });
    // o saldo entra pelo mesmo aviso (webhook) das recargas normais; se o cartão for confirmado na hora, creditamos já
    if (['CONFIRMED', 'RECEIVED'].includes(pay.status)) {
      await require('./walletTopupService').applyPaid({ ...pay, externalReference: `topup:${topup.id}` });
    }
    return { userId: w.userId, ok: true };
  } catch (e) {
    await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: 'cancelled' } }).catch(() => null);
    await prisma.wallet.update({ where: { userId: w.userId }, data: { autoRechargeEnabled: false, autoRechargeFailedAt: new Date() } });
    await notifyFailure(w.userId, e.message);
    return { userId: w.userId, ok: false, error: e.message };
  }
}

async function runNow() {
  if (!asaas.isEnabled()) return [];
  const wallets = await prisma.wallet.findMany({ where: { enabled: true, autoRechargeEnabled: true, autoCardToken: { not: null } }, take: 5000 });
  const out = [];
  for (const w of wallets) {
    if (!(w.autoRechargeThresholdBrl > 0) || !(w.autoRechargeAmountBrl > 0)) continue;
    if (w.balanceBrl > w.autoRechargeThresholdBrl) continue;
    const r = await chargeOne(w).catch((e) => ({ userId: w.userId, ok: false, error: e.message }));
    if (r) out.push(r);
  }
  return out;
}

module.exports = { status, configure, removeCard, captureToken, runNow };
