// backend/src/controllers/voiceController.js
// Telefone SIP do navegador: credenciais do ramal da pessoa logada, busca de nome do contato e histórico de chamadas.
const prisma = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../services/crypto/settingsCrypto');
const { ensureExtensionForMember } = require('../services/smsgw/sipExtensions');

const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function iceServers() {
  try {
    const parsed = env.webrtcIceServers ? JSON.parse(env.webrtcIceServers) : null;
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

function wssUrl() {
  if (env.asteriskWssUrl) return env.asteriskWssUrl;
  try {
    const u = new URL(env.frontendUrl);
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/asterisk-ws`;
  } catch {
    return '';
  }
}

function sipDomain() {
  try {
    return new URL(env.frontendUrl).hostname;
  } catch {
    return 'localhost';
  }
}

/** Dados para o telefone registrar no Asterisk (cria o ramal da pessoa na primeira vez). */
exports.me = async (req, res, next) => {
  try {
    const ext = await ensureExtensionForMember(req.userId, req.memberId);
    const member = await prisma.member.findUnique({ where: { id: req.memberId }, select: { name: true } });
    res.json({
      wssUrl: wssUrl(),
      domain: sipDomain(),
      extension: ext.extension,
      password: decrypt(ext.passwordEnc),
      displayName: member?.name || ext.extension,
      iceServers: iceServers()
    });
  } catch (error) {
    next(error);
  }
};

function digitsVariants(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const out = new Set();
  if (d.length >= 8) {
    out.add(d);
    if (d.startsWith('55')) out.add(d.slice(2));
  }
  return [...out];
}

/** Nome do contato (lead) dono de um número, para mostrar na ligação recebida. */
exports.lookup = async (req, res, next) => {
  try {
    const variants = digitsVariants(req.query.number);
    if (!variants.length) return res.json({ name: null });
    const leads = await prisma.lead.findMany({
      where: { userId: req.userId, phone: { not: null } },
      select: { name: true, phone: true },
      take: 20000
    });
    const hit = leads.find((l) => {
      const p = String(l.phone).replace(/\D/g, '');
      return variants.some((v) => p === v || p.endsWith(v) || v.endsWith(p));
    });
    res.json({ name: hit?.name || null });
  } catch (error) {
    next(error);
  }
};

exports.logCall = async (req, res, next) => {
  try {
    const b = req.body || {};
    const startedAt = new Date(b.startedAt || Date.now());
    const answeredAt = b.answeredAt ? new Date(b.answeredAt) : null;
    const endedAt = b.endedAt ? new Date(b.endedAt) : new Date();
    const durationSec = answeredAt ? Math.max(0, Math.round((endedAt - answeredAt) / 1000)) : 0;
    const row = await prisma.sipCallLog.create({
      data: {
        userId: req.userId,
        memberId: req.memberId,
        direction: b.direction === 'in' ? 'in' : 'out',
        number: String(b.number || '').replace(/[^\d+*#]/g, '').slice(0, 30),
        contactName: b.contactName ? String(b.contactName).slice(0, 120) : null,
        status: ['answered', 'missed', 'rejected', 'failed', 'canceled', 'busy'].includes(b.status) ? b.status : 'failed',
        startedAt,
        answeredAt,
        endedAt,
        durationSec
      }
    });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
};

exports.listCalls = async (req, res, next) => {
  try {
    const isAdmin = ['owner', 'admin'].includes(req.memberRole);
    const where = { userId: req.userId, ...(isAdmin ? {} : { memberId: req.memberId }) };
    res.json(await prisma.sipCallLog.findMany({ where, orderBy: { startedAt: 'desc' }, take: 50 }));
  } catch (error) {
    next(error);
  }
};
