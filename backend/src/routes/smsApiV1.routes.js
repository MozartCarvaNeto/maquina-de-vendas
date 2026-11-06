// backend/src/routes/smsApiV1.routes.js
// API própria de SMS para sistemas externos:  POST /api/v1/sms/messages  (Authorization: Bearer tp_live_...)
const express = require('express');
const crypto = require('crypto');
const prisma = require('../config/db');
const gateway = require('../services/smsgw/gateway');
const { isAccountBlocked } = require('../services/accessService');
const { accountHasFeature } = require('../services/featureService');
const router = express.Router();

const hits = new Map(); // limite simples por chave: 30 pedidos por segundo
setInterval(() => hits.clear(), 1000).unref();

async function apiKeyAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
    if (!raw) return res.status(401).json({ error: 'Informe a chave: Authorization: Bearer tp_live_...' });
    const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
    const key = await prisma.smsApiKey.findUnique({ where: { keyHash } });
    if (!key || !key.active) return res.status(401).json({ error: 'Chave de API inválida.' });
    const n = (hits.get(key.id) || 0) + 1;
    hits.set(key.id, n);
    if (n > 30) return res.status(429).json({ error: 'Muitos pedidos por segundo. Aguarde um instante.' });
    if (await isAccountBlocked(key.userId)) return res.status(403).json({ error: 'Conta suspensa (assinatura vencida ou bloqueio).' });
    if (!(await accountHasFeature(key.userId, 'gateway'))) return res.status(403).json({ error: 'O plano da conta não inclui o Gateway de telecom.' });
    req.userId = key.userId;
    req.apiKeyId = key.id;
    prisma.smsApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => null);
    next();
  } catch (error) {
    next(error);
  }
}

function present(m) {
  return {
    id: m.id, to: m.toAddr, from: m.fromAddr, status: m.status, parts: m.parts, encoding: m.encoding,
    error: m.errorMessage || null, clientRef: m.clientRef, createdAt: m.createdAt, sentAt: m.sentAt, deliveredAt: m.deliveredAt
  };
}

router.use(apiKeyAuth);

// Corpo: { "to": "11999998888", "body": "Texto", "from": "MARCA" (opcional), "clientRef": "pedido-123" (opcional) }
router.post('/messages', async (req, res, next) => {
  try {
    const { to, body, from, clientRef } = req.body || {};
    const msg = await gateway.enqueue({ userId: req.userId, to, body, from, clientRef, source: 'api', apiKeyId: req.apiKeyId });
    res.status(202).json(present(msg));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
});

router.get('/messages/:id', async (req, res, next) => {
  try {
    const msg = await prisma.smsMessage.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    res.json(present(msg));
  } catch (error) {
    next(error);
  }
});

router.get('/messages', async (req, res, next) => {
  try {
    const rows = await prisma.smsMessage.findMany({
      where: { userId: req.userId, source: 'api', direction: 'out' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Number(req.query.limit) || 20)
    });
    res.json(rows.map(present));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
