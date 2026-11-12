// backend/src/services/walletService.js
// Saldo pré-pago por conta. Conta sem carteira ligada = sem limite (comportamento antigo).
const prisma = require('../config/db');

const r4 = (n) => Math.round(Number(n) * 10000) / 10000;

async function getWallet(userId) {
  return prisma.wallet.findUnique({ where: { userId } });
}

async function isActive(userId) {
  const w = await getWallet(userId);
  return w && w.enabled ? w : null;
}

async function record(userId, type, amount, description, refId, extra = {}) {
  const w = await getWallet(userId);
  return prisma.walletTx.create({ data: { userId, type, amountBrl: r4(amount), balanceAfter: r4(w?.balanceBrl || 0), description: String(description).slice(0, 200), refId: refId || null, costBrl: r4(extra.costBrl || 0), quantity: r4(extra.quantity || 0) } });
}

/** Cobra. Sem saldo → erro 402 (a menos que force: ligações já feitas não podem ser recusadas). */
async function charge(userId, amount, { type = 'uso', description = '', refId = null, force = false, costBrl = 0, quantity = 0, direction = null, incrementSec = 60 } = {}) {
  amount = r4(amount);
  if (!(amount > 0)) return { charged: false };
  const w = await isActive(userId);
  if (!w) return { charged: false };
  // Cliente de revendedor: se o revendedor ficou sem saldo de atacado, o serviço pausa (exceto o que já aconteceu).
  const reseller = ['sms', 'voz', 'whatsapp'].includes(type) ? await resellerOf(userId) : null;
  if (reseller && !force) {
    const rw = await isActive(reseller);
    if (rw && rw.balanceBrl <= 0) {
      const err = new Error('Serviço temporariamente indisponível. Fale com o seu fornecedor.');
      err.status = 402;
      err.configProblem = true;
      throw err;
    }
  }
  if (force) {
    await prisma.wallet.update({ where: { userId }, data: { balanceBrl: { decrement: amount } } });
  } else {
    const r = await prisma.wallet.updateMany({ where: { userId, enabled: true, balanceBrl: { gte: amount } }, data: { balanceBrl: { decrement: amount } } });
    if (!r.count) {
      const err = new Error('Saldo insuficiente. Peça uma recarga ao administrador do serviço.');
      err.status = 402;
      err.configProblem = true;
      throw err;
    }
  }
  await record(userId, type, -amount, description, refId, { costBrl, quantity });
  if (reseller) await billReseller(reseller, userId, { type, quantity, direction, incrementSec, description, refId, costBrl }).catch((e) => console.warn('Cobrança de atacado:', e.message));
  return { charged: true, amount };
}

async function resellerOf(userId) {
  const a = await prisma.account.findUnique({ where: { id: userId }, select: { resellerId: true } });
  return a?.resellerId || null;
}

/** Atacado: a plataforma cobra do REVENDEDOR a tarifa de atacado (as tarifas da conta dele) por tudo que o cliente usa. */
async function billReseller(resellerId, clientId, { type, quantity, direction, incrementSec, description, refId, costBrl }) {
  const rw = await isActive(resellerId);
  if (!rw) return;
  let wholesale = 0;
  if (type === 'sms') {
    const gw = await require('./smsgw/gateway').getGatewaySettings(resellerId);
    wholesale = r4((gw.priceBrl || 0) * (quantity || 1));
  } else if (type === 'voz') {
    wholesale = voiceCost(direction === 'entrada' ? rw.voiceInPerMinBrl : rw.voiceOutPerMinBrl, quantity || 0, incrementSec);
  } else if (type === 'whatsapp') {
    wholesale = 0; // WhatsApp oficial é do próprio revendedor/cliente; sem atacado
  }
  if (!(wholesale > 0)) return;
  const client = await prisma.account.findUnique({ where: { id: clientId }, select: { name: true } });
  await prisma.wallet.update({ where: { userId: resellerId }, data: { balanceBrl: { decrement: wholesale } } });
  await record(resellerId, 'atacado', -wholesale, `Atacado — ${client?.name || 'cliente'}: ${description}`, refId, { costBrl, quantity });
}

async function credit(userId, amount, { type = 'recarga', description = 'Recarga', refId = null } = {}) {
  amount = r4(amount);
  if (!(amount > 0)) throw Object.assign(new Error('Valor inválido.'), { status: 400 });
  await prisma.wallet.upsert({ where: { userId }, update: { balanceBrl: { increment: amount } }, create: { userId, balanceBrl: amount } });
  await record(userId, type, amount, description, refId);
}

async function refund(userId, amount, description, refId) {
  if (!(amount > 0)) return;
  const w = await isActive(userId);
  if (!w) return;
  await credit(userId, amount, { type: 'estorno', description, refId });
}

/** Quanto tempo de ligação o saldo aguenta. maxSeconds = null → sem limite. */
async function voiceAllowance(userId) {
  // limite de minutos do plano (por mês)
  const planLeft = await require('./telecomLimitService').voiceSecondsLeft(userId).catch(() => null);
  if (planLeft !== null && planLeft < 6) return { allowed: false, maxSeconds: 0, planLimit: true };
  const w = await isActive(userId);
  if (!w || !(w.voiceOutPerMinBrl > 0)) return { allowed: true, maxSeconds: planLeft };
  if (w.balanceBrl <= 0) return { allowed: false, maxSeconds: 0 };
  let maxSeconds = Math.floor((w.balanceBrl / w.voiceOutPerMinBrl) * 60);
  if (planLeft !== null) maxSeconds = Math.min(maxSeconds, planLeft);
  return { allowed: maxSeconds >= 6, maxSeconds };
}

function voiceCost(ratePerMin, seconds, incrementSec = 60) {
  if (!(ratePerMin > 0) || !(seconds > 0)) return 0;
  const inc = Math.max(1, incrementSec || 60);
  return r4((Math.ceil(seconds / inc) * inc * ratePerMin) / 60);
}

/** Cobra uma ligação encerrada (uma vez só: quem chama confere se já cobrou). Devolve o valor cobrado. */
async function chargeCall(userId, { direction, seconds, refId, description }) {
  await require('./telecomLimitService').recordVoice(userId, seconds);
  const w = await isActive(userId);
  if (!w) return 0;
  const rate = direction === 'entrada' ? w.voiceInPerMinBrl : w.voiceOutPerMinBrl;
  const cost = voiceCost(rate, seconds, w.voiceIncrementSec);
  if (cost > 0) {
    // o que a plataforma paga ao fornecedor por essa ligação (regras do administrador) — alimenta o painel de lucro
    const rules = await require('./platformBillingSettings').get().catch(() => null);
    const carrierRate = rules ? (direction === 'entrada' ? rules.voiceCostInPerMinBrl : rules.voiceCostOutPerMinBrl) : 0;
    const costBrl = rules ? voiceCost(carrierRate, seconds, rules.voiceCostIncrementSec) : 0;
    await charge(userId, cost, { type: 'voz', description, refId, force: true, costBrl, quantity: seconds, direction, incrementSec: w.voiceIncrementSec });
  }
  return cost;
}

async function saveRates(userId, { enabled, voiceOutPerMinBrl, voiceInPerMinBrl, voiceIncrementSec }) {
  const data = {};
  if (enabled !== undefined) data.enabled = !!enabled;
  const money = (v) => Math.max(0, Math.min(1000, r4(v)));
  if (voiceOutPerMinBrl !== undefined) data.voiceOutPerMinBrl = money(voiceOutPerMinBrl);
  if (voiceInPerMinBrl !== undefined) data.voiceInPerMinBrl = money(voiceInPerMinBrl);
  if (voiceIncrementSec !== undefined) data.voiceIncrementSec = [1, 6, 30, 60].includes(Number(voiceIncrementSec)) ? Number(voiceIncrementSec) : 60;
  return prisma.wallet.upsert({ where: { userId }, update: data, create: { userId, ...data } });
}

module.exports = { getWallet, isActive, charge, credit, refund, voiceAllowance, voiceCost, chargeCall, saveRates };
