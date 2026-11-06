// backend/src/controllers/gatewayController.js
// Painel do "Gateway de telecom": fornecedores SMPP, mensagens, consumo, chaves de API, troncos SIP.
const crypto = require('crypto');
const prisma = require('../config/db');
const { encrypt } = require('../services/crypto/settingsCrypto');
const gateway = require('../services/smsgw/gateway');
const { countSegments } = require('../services/smsgw/gsm');
const { buildAsteriskConfig } = require('../services/smsgw/asteriskConfig');
const { ensureAllExtensions } = require('../services/smsgw/sipExtensions');

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
      carriers: carriers.map(publicCarrier),
      last24h: counts,
      settings: await gateway.getGatewaySettings(userId)
    });
  } catch (error) {
    next(error);
  }
};

exports.saveSettings = async (req, res, next) => {
  try {
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
    const { to, body, from } = req.body || {};
    const msg = await gateway.enqueue({ userId: req.userId, to, body, from, source: 'app' });
    res.status(202).json({ id: msg.id, status: msg.status, parts: msg.parts, encoding: msg.encoding });
  } catch (error) {
    if (error.status === 400) return badRequest(res, error.message);
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
    res.json(rows);
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
    res.json({ days, total, byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- chaves de API
exports.listKeys = async (req, res, next) => {
  try {
    const keys = await prisma.smsApiKey.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } });
    res.json(keys.map(({ keyHash, ...k }) => k));
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
    const trunks = await prisma.sipTrunk.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'asc' } });
    const extensions = await ensureAllExtensions(req.userId);
    res.json(buildAsteriskConfig(trunks, extensions));
  } catch (error) {
    next(error);
  }
};
