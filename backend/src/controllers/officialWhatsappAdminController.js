// backend/src/controllers/officialWhatsappAdminController.js
// Administrador: cadastra, para um cliente, um número do WhatsApp oficial (Cloud API) da SUA conta Meta.
// As mensagens enviadas por ele são cobradas do saldo do cliente (tarifa configurável).
const prisma = require('../config/db');
const env = require('../config/env');
const meta = require('../services/whatsapp/metaCloudApiService');

exports.list = async (req, res, next) => {
  try {
    const rows = await prisma.whatsappConnection.findMany({
      where: { provider: 'cloud_api', managed: true },
      include: { account: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({
      webhookUrl: `${env.backendPublicUrl.replace(/\/$/, '')}/api/whatsapp-cloud/webhook`,
      items: rows.map((c) => ({
        id: c.id, accountId: c.userId, accountName: c.account.name, instanceName: c.instanceName, phone: c.phone,
        phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, status: c.status, priceBrl: c.priceBrl,
        webhookVerifyToken: c.webhookVerifyToken
      }))
    });
  } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try {
    const b = req.body || {};
    const account = await prisma.account.findUnique({ where: { id: String(b.accountId || '') } });
    if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const price = b.priceBrl === '' || b.priceBrl == null ? null : Number(String(b.priceBrl).replace(',', '.'));
    if (price !== null && !(price >= 0)) return res.status(400).json({ error: 'Preço inválido.' });
    const conn = await meta.createConnection(account.id, {
      instanceName: String(b.instanceName || '').trim() || 'WhatsApp oficial',
      phoneNumberId: String(b.phoneNumberId || '').trim(), wabaId: b.wabaId, accessToken: String(b.accessToken || '').trim(), appSecret: b.appSecret
    });
    await prisma.whatsappConnection.update({ where: { id: conn.id }, data: { managed: true, priceBrl: price } });
    res.status(201).json({ id: conn.id, webhookVerifyToken: conn.webhookVerifyToken });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const data = {};
    if (req.body.priceBrl !== undefined) {
      const p = req.body.priceBrl === '' || req.body.priceBrl === null ? null : Number(String(req.body.priceBrl).replace(',', '.'));
      if (p !== null && !(p >= 0)) return res.status(400).json({ error: 'Preço inválido.' });
      data.priceBrl = p;
    }
    const r = await prisma.whatsappConnection.updateMany({ where: { id: req.params.id, managed: true }, data });
    res.json({ success: r.count === 1 });
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    await prisma.whatsappConnection.deleteMany({ where: { id: req.params.id, managed: true } });
    res.json({ success: true });
  } catch (e) { next(e); }
};
