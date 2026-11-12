// backend/src/controllers/gatewayController.js
// Painel do "Gateway de telecom": fornecedores SMPP, mensagens, consumo, chaves de API, troncos SIP.
const crypto = require('crypto');
const prisma = require('../config/db');
const { encrypt } = require('../services/crypto/settingsCrypto');
const gateway = require('../services/smsgw/gateway');
const { countSegments } = require('../services/smsgw/gsm');
const { buildAsteriskConfig } = require('../services/smsgw/asteriskConfig');
const { ensureAllExtensions } = require('../services/smsgw/sipExtensions');
const wallet = require('../services/walletService');
const smsWebhook = require('../services/smsgw/smsWebhook');

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|\[::1\]|fc|fd)/i;

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

function publicCarrier(c) {
  const { passwordEnc, ...rest } = c;
  return { ...rest, hasPassword: Boolean(passwordEnc), runtime: gateway.carrierRuntime(c.id) };
}

function parseCarrierBody(body, req) {
  const host = String(body.host || '').trim();
  if (!host) return { error: 'Informe o servidor (host) do fornecedor.' };
  if (!req.isPlatformAdmin && PRIVATE_HOST.test(host)) return { error: 'Endereço de rede interna não é permitido.' };
  const port = Number(body.port) || 2775;
  if (port < 1 || port > 65535) return { error: 'Porta inválida.' };
  const systemId = String(body.systemId || '').trim();
  if (!systemId) return { error: 'Informe o usuário (system_id) do SMPP.' };
  return {
    data: {
      name: String(body.name || host).trim().slice(0, 80),
      host,
      port,
      useTls: Boolean(body.useTls),
      systemId,
      systemType: String(body.systemType || '').trim() || null,
      defaultSender: String(body.defaultSender || '').trim().slice(0, 20) || null,
      tps: Math.min(1000, Math.max(0.1, Number(body.tps) || 10)),
      windowSize: Math.min(100, Math.max(1, Math.round(Number(body.windowSize) || 10))),
      priority: Math.min(99, Math.max(1, Math.round(Number(body.priority) || 1))),
      costPerPart: Math.max(0, Number(body.costPerPart) || 0),
      normalize: body.normalize === 'strip' ? 'strip' : 'keep',
      concatMode: body.concatMode === 'sar' ? 'sar' : 'udh',
      allowedPrefixes: String(body.allowedPrefixes || '').replace(/[^\d,\s]/g, '').trim() || null,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled)
    }
  };
}

// ---------------------------------------------------------------- visão geral
exports.overview = async (req, res, next) => {
  try {
    const userId = req.userId;
    const carriers = await prisma.smsCarrier.findMany({ where: { userId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await prisma.smsMessage.findMany({ where: { userId, direction: 'out', createdAt: { gte: since } }, select: { status: true } });
    const counts = {};
    recent.forEach((m) => { counts[m.status] = (counts[m.status] || 0) + 1; });
    res.json({
      carriers: req.isPlatformAdmin ? carriers.map(publicCarrier) : [],
      isPlatformAdmin: Boolean(req.isPlatformAdmin),
      last24h: counts,
      settings: await gateway.getGatewaySettings(userId)
    });
  } catch (error) {
    next(error);
  }
};

exports.saveSettings = async (req, res, next) => {
  try {
    if (!req.isPlatformAdmin && (await wallet.isActive(req.userId)) && req.body && req.body.priceBrl !== undefined) {
      return res.status(403).json({ error: 'Com saldo pré-pago ligado, o preço do SMS é definido pelo administrador do serviço.' });
    }
    await gateway.saveGatewaySettings(req.userId, {
      priceBrl: req.body.priceBrl,
      useInBroadcasts: req.body.useInBroadcasts
    });
    res.json({ success: true, settings: await gateway.getGatewaySettings(req.userId) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- fornecedores SMPP
exports.createCarrier = async (req, res, next) => {
  try {
    const parsed = parseCarrierBody(req.body, req);
    if (parsed.error) return badRequest(res, parsed.error);
    if (!req.body.password) return badRequest(res, 'Informe a senha do SMPP.');
    const carrier = await prisma.smsCarrier.create({
      data: { ...parsed.data, userId: req.userId, passwordEnc: encrypt(String(req.body.password)) }
    });
    await gateway.syncCarrier(carrier.id);
    res.status(201).json(publicCarrier(carrier));
  } catch (error) {
    next(error);
  }
};

exports.updateCarrier = async (req, res, next) => {
  try {
    const existing = await prisma.smsCarrier.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    const parsed = parseCarrierBody({ ...existing, ...req.body }, req);
    if (parsed.error) return badRequest(res, parsed.error);
    const data = { ...parsed.data };
    if (req.body.password) data.passwordEnc = encrypt(String(req.body.password));
    const carrier = await prisma.smsCarrier.update({ where: { id: existing.id }, data });
    await gateway.syncCarrier(carrier.id);
    res.json(publicCarrier(carrier));
  } catch (error) {
    next(error);
  }
};

exports.deleteCarrier = async (req, res, next) => {
  try {
    const existing = await prisma.smsCarrier.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    gateway.stopCarrier(existing.id);
    await prisma.smsCarrier.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- mensagens
exports.sendTest = async (req, res, next) => {
  try {
    const { to, body, from, sendAt } = req.body || {};
    const msg = await gateway.enqueue({ userId: req.userId, to, body, from, sendAt, source: 'app' });
    res.status(202).json({ id: msg.id, status: msg.status, parts: msg.parts, encoding: msg.encoding, scheduledFor: sendAt ? msg.nextAttemptAt : null });
  } catch (error) {
    if (error.status === 400) return badRequest(res, error.message);
    if (error.status === 402) return res.status(402).json({ error: error.message });
    next(error);
  }
};

exports.previewSegments = (req, res) => {
  const { parts, encoding } = countSegments(String(req.body?.body || ''), { normalize: req.body?.normalize === 'strip' ? 'strip' : 'keep' });
  res.json({ parts, encoding });
};

exports.listMessages = async (req, res, next) => {
  try {
    const where = { userId: req.userId };
    if (['out', 'in'].includes(req.query.direction)) where.direction = req.query.direction;
    if (req.query.status) where.status = String(req.query.status);
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await prisma.smsMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take });
    // O custo e o fornecedor usados são da plataforma: cliente não vê.
    res.json(req.isPlatformAdmin ? rows : rows.map(({ costBrl, carrierId, providerMessageId, ...m }) => m));
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- consumo / extrato
exports.usage = async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await prisma.smsMessage.findMany({
      where: { userId: req.userId, direction: 'out', createdAt: { gte: since }, status: { in: ['sent', 'delivered', 'undelivered'] } },
      select: { createdAt: true, parts: true, costBrl: true, priceBrl: true, status: true, source: true },
      take: 100000
    });
    const byDay = {};
    const total = { messages: 0, parts: 0, cost: 0, revenue: 0, delivered: 0 };
    for (const r of rows) {
      const day = new Date(r.createdAt.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const d = (byDay[day] = byDay[day] || { day, messages: 0, parts: 0, cost: 0, revenue: 0, delivered: 0 });
      d.messages += 1; d.parts += r.parts; d.cost += r.costBrl; d.revenue += r.priceBrl; if (r.status === 'delivered') d.delivered += 1;
      total.messages += 1; total.parts += r.parts; total.cost += r.costBrl; total.revenue += r.priceBrl; if (r.status === 'delivered') total.delivered += 1;
    }
    const days2 = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1));
    if (!req.isPlatformAdmin) {
      // cliente vê só o que gastou (sem o custo da plataforma)
      total.cost = 0;
      days2.forEach((d) => { d.cost = 0; });
    }
    res.json({ days, total, byDay: days2 });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- chaves de API
exports.listKeys = async (req, res, next) => {
  try {
    const keys = await prisma.smsApiKey.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } });
    res.json(keys.map(({ keyHash, ...k }) => ({ ...k, webhookSecret: smsWebhook.webhookSecret(k.id) })));
  } catch (error) {
    next(error);
  }
};

exports.createKey = async (req, res, next) => {
  try {
    const raw = `tp_live_${crypto.randomBytes(24).toString('hex')}`;
    const key = await prisma.smsApiKey.create({
      data: {
        userId: req.userId,
        name: String(req.body?.name || 'Chave').trim().slice(0, 60),
        prefix: raw.slice(0, 12),
        keyHash: crypto.createHash('sha256').update(raw).digest('hex')
      }
    });
    // A chave inteira só aparece agora; depois só o início (prefixo).
    res.status(201).json({ id: key.id, name: key.name, key: raw });
  } catch (error) {
    next(error);
  }
};

exports.deleteKey = async (req, res, next) => {
  try {
    const r = await prisma.smsApiKey.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    if (!r.count) return res.status(404).json({ error: 'Chave não encontrada.' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- troncos SIP (voz)
function publicTrunk(t) {
  const { passwordEnc, ...rest } = t;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

function parseTrunk(body) {
  const host = String(body.host || '').trim();
  if (!host) return { error: 'Informe o servidor SIP do fornecedor.' };
  const codecs = String(body.codecs || 'alaw,ulaw').split(',').map((c) => c.trim().toLowerCase()).filter((c) => /^[a-z0-9]+$/.test(c));
  return {
    data: {
      name: String(body.name || host).trim().slice(0, 60),
      host,
      port: Math.min(65535, Math.max(1, Number(body.port) || 5060)),
      transport: ['udp', 'tcp', 'tls'].includes(body.transport) ? body.transport : 'udp',
      username: String(body.username || '').trim() || null,
      register: Boolean(body.register),
      fromDomain: String(body.fromDomain || '').trim() || null,
      outboundCallerId: String(body.outboundCallerId || '').replace(/[^\d+]/g, '') || null,
      dialPrefix: String(body.dialPrefix || '').replace(/[^\d]/g, '') || null,
      codecs: (codecs.length ? codecs : ['alaw', 'ulaw']).join(','),
      enabled: body.enabled === undefined ? true : Boolean(body.enabled)
    }
  };
}

exports.listTrunks = async (req, res, next) => {
  try {
    const trunks = await prisma.sipTrunk.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'asc' } });
    res.json(trunks.map(publicTrunk));
  } catch (error) {
    next(error);
  }
};

exports.createTrunk = async (req, res, next) => {
  try {
    const parsed = parseTrunk(req.body);
    if (parsed.error) return badRequest(res, parsed.error);
    const trunk = await prisma.sipTrunk.create({
      data: { ...parsed.data, userId: req.userId, passwordEnc: req.body.password ? encrypt(String(req.body.password)) : null }
    });
    res.status(201).json(publicTrunk(trunk));
  } catch (error) {
    next(error);
  }
};

exports.updateTrunk = async (req, res, next) => {
  try {
    const existing = await prisma.sipTrunk.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ error: 'Tronco não encontrado.' });
    const parsed = parseTrunk({ ...existing, ...req.body });
    if (parsed.error) return badRequest(res, parsed.error);
    const data = { ...parsed.data };
    if (req.body.password) data.passwordEnc = encrypt(String(req.body.password));
    res.json(publicTrunk(await prisma.sipTrunk.update({ where: { id: existing.id }, data })));
  } catch (error) {
    next(error);
  }
};

exports.deleteTrunk = async (req, res, next) => {
  try {
    const r = await prisma.sipTrunk.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    if (!r.count) return res.status(404).json({ error: 'Tronco não encontrado.' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.asteriskConfig = async (req, res, next) => {
  try {
    res.json(await require('../services/pbx/pbxService').loadPbxConfig(req.userId));
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- webhook, cancelamento, conversas
exports.setKeyWebhook = async (req, res, next) => {
  try {
    const url = String(req.body?.url || '').trim();
    const key = await prisma.smsApiKey.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!key) return res.status(404).json({ error: 'Chave não encontrada.' });
    const clean = url ? await smsWebhook.validateUrl(url) : null;
    await prisma.smsApiKey.update({ where: { id: key.id }, data: { webhookUrl: clean } });
    res.json({ success: true, webhookUrl: clean, webhookSecret: smsWebhook.webhookSecret(key.id) });
  } catch (error) {
    if (error.status === 400) return badRequest(res, error.message);
    next(error);
  }
};

exports.cancelMessage = async (req, res, next) => {
  try {
    res.json(await gateway.cancelQueued(req.userId, req.params.id));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

const digitsKey = (v) => String(v || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');

/** Caixa de entrada: uma conversa por número (últimas mensagens enviadas e recebidas). */
exports.conversations = async (req, res, next) => {
  try {
    const rows = await prisma.smsMessage.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const map = new Map();
    for (const m of rows) {
      const number = m.direction === 'in' ? m.fromAddr : m.toAddr;
      const k = digitsKey(number);
      if (!k) continue;
      const c = map.get(k) || { number, last: m, count: 0, received: 0 };
      c.count += 1;
      if (m.direction === 'in') c.received += 1;
      map.set(k, c);
    }
    const list = [...map.values()].slice(0, 100).map((c) => ({ number: c.number, key: digitsKey(c.number), lastBody: c.last.body.slice(0, 120), lastAt: c.last.createdAt, lastDirection: c.last.direction, lastStatus: c.last.status, count: c.count, received: c.received }));
    res.json(list);
  } catch (error) {
    next(error);
  }
};

exports.conversation = async (req, res, next) => {
  try {
    const k = digitsKey(req.params.number);
    if (k.length < 8) return badRequest(res, 'Número inválido.');
    const rows = await prisma.smsMessage.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const msgs = rows.filter((m) => digitsKey(m.direction === 'in' ? m.fromAddr : m.toAddr) === k).slice(0, 200).reverse();
    res.json(msgs.map((m) => ({ id: m.id, direction: m.direction, body: m.body, status: m.status, createdAt: m.createdAt, scheduledFor: m.status === 'queued' && m.nextAttemptAt > new Date() ? m.nextAttemptAt : null, error: m.errorMessage })));
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- saldo pré-pago
exports.walletMe = async (req, res, next) => {
  try {
    const w = await wallet.getWallet(req.userId);
    const txs = await prisma.walletTx.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const settings = await gateway.getGatewaySettings(req.userId);
    const rules = await require('../services/platformBillingSettings').get();
    const topup = await require('../services/walletTopupService');
    const lowLimit = w?.lowBalanceBrl ?? rules.walletLowDefaultBrl;
    res.json({
      enabled: Boolean(w?.enabled),
      balanceBrl: w?.balanceBrl || 0,
      lowBalanceBrl: w?.lowBalanceBrl ?? null,
      lowDefaultBrl: rules.walletLowDefaultBrl,
      lowBalance: Boolean(w?.enabled && lowLimit > 0 && (w?.balanceBrl || 0) <= lowLimit),
      topup: await topup.config(),
      topups: await topup.listTopups(req.userId),
      rates: { smsPerPartBrl: settings.priceBrl, voiceOutPerMinBrl: w?.voiceOutPerMinBrl || 0, voiceInPerMinBrl: w?.voiceInPerMinBrl || 0, voiceIncrementSec: w?.voiceIncrementSec || 60 },
      txs
    });
  } catch (error) {
    next(error);
  }
};

exports.walletLow = async (req, res, next) => {
  try {
    const w = await wallet.getWallet(req.userId);
    const rules = await require('../services/platformBillingSettings').get();
    const limit = w?.lowBalanceBrl ?? rules.walletLowDefaultBrl;
    res.json({ low: Boolean(!req.isPlatformAdmin && w?.enabled && limit > 0 && w.balanceBrl <= limit), balanceBrl: w?.balanceBrl || 0 });
  } catch (error) {
    next(error);
  }
};

exports.autoRechargeGet = async (req, res, next) => {
  try { res.json(await require('../services/autoRechargeService').status(req.userId)); } catch (e) { next(e); }
};
exports.autoRechargeSave = async (req, res, next) => {
  try { res.json(await require('../services/autoRechargeService').configure(req.userId, req.body || {}, req.ip)); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
};
exports.autoRechargeRemoveCard = async (req, res, next) => {
  try { res.json(await require('../services/autoRechargeService').removeCard(req.userId)); } catch (e) { next(e); }
};

exports.walletTopup = async (req, res, next) => {
  try {
    res.status(201).json(await require('../services/walletTopupService').createTopup({ accountId: req.userId, amountBrl: req.body?.amountBrl, cpfCnpj: req.body?.cpfCnpj }));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

exports.walletLowBalance = async (req, res, next) => {
  try {
    const v = req.body?.lowBalanceBrl;
    const value = v === null || v === '' || v === undefined ? null : Math.max(0, Math.min(100000, Number(String(v).replace(',', '.'))));
    if (value !== null && !Number.isFinite(value)) return badRequest(res, 'Valor inválido.');
    await prisma.wallet.upsert({ where: { userId: req.userId }, update: { lowBalanceBrl: value, lowNotifiedAt: null }, create: { userId: req.userId, lowBalanceBrl: value } });
    res.json({ success: true, lowBalanceBrl: value });
  } catch (error) {
    next(error);
  }
};

exports.walletStatement = async (req, res, next) => {
  try {
    const rep = require('../services/walletReportService');
    const st = await rep.statement(req.userId, { from: req.query.from, to: req.query.to });
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="extrato.csv"');
      return res.send(rep.statementCsv(st));
    }
    res.json(st);
  } catch (error) {
    next(error);
  }
};

exports.adminBillingRules = async (req, res, next) => {
  try {
    const s = require('../services/platformBillingSettings');
    if (req.method === 'PUT') return res.json(await s.save(req.body || {}));
    res.json(await s.get(true));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

exports.adminProfit = async (req, res, next) => {
  try {
    res.json(await require('../services/walletReportService').profit({ months: parseInt(req.query.months, 10) || 6, month: /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null }));
  } catch (error) {
    next(error);
  }
};

exports.walletAccounts = async (req, res, next) => {
  try {
    const [accounts, wallets] = await Promise.all([prisma.account.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }), prisma.wallet.findMany({})]);
    const byUser = new Map(wallets.map((w) => [w.userId, w]));
    const out = [];
    for (const a of accounts) {
      const w = byUser.get(a.id);
      const s = await gateway.getGatewaySettings(a.id);
      out.push({ id: a.id, name: a.name, enabled: Boolean(w?.enabled), balanceBrl: w?.balanceBrl || 0, smsPerPartBrl: s.priceBrl, voiceOutPerMinBrl: w?.voiceOutPerMinBrl || 0, voiceInPerMinBrl: w?.voiceInPerMinBrl || 0, voiceIncrementSec: w?.voiceIncrementSec || 60 });
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};

exports.walletCredit = async (req, res, next) => {
  try {
    const amount = Number(req.body?.amountBrl);
    if (!(amount > 0) || amount > 1000000) return badRequest(res, 'Informe um valor de recarga maior que zero.');
    const acc = await prisma.account.findUnique({ where: { id: req.params.userId }, select: { id: true } });
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada.' });
    await wallet.credit(acc.id, amount, { description: String(req.body?.description || 'Recarga manual').slice(0, 150) });
    // pagou: tenta cobrar a mensalidade de número em atraso e reativa o número
    require('../jobs/didJob').runBillingNow().catch((e) => console.warn('Mensalidade após recarga:', e.message));
    res.json({ success: true, balanceBrl: (await wallet.getWallet(acc.id)).balanceBrl });
  } catch (error) {
    next(error);
  }
};

exports.walletRates = async (req, res, next) => {
  try {
    const acc = await prisma.account.findUnique({ where: { id: req.params.userId }, select: { id: true } });
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada.' });
    const b = req.body || {};
    await wallet.saveRates(acc.id, b);
    if (b.smsPerPartBrl !== undefined) await gateway.saveGatewaySettings(acc.id, { priceBrl: b.smsPerPartBrl });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
