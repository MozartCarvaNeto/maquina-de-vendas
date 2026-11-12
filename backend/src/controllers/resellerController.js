// backend/src/controllers/resellerController.js
// Revendedor (agência): cria e gerencia clientes dentro da própria conta.
//  - Tarifa de ATACADO = as tarifas (SMS/voz) da própria conta do revendedor, definidas pelo administrador.
//  - O revendedor define a tarifa de cada cliente (nunca abaixo da dele) e adiciona saldo ao cliente (que paga ao revendedor por fora).
//  - Conforme o cliente usa, a plataforma debita da carteira do REVENDEDOR a tarifa de atacado. Sem saldo do revendedor, os clientes pausam.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/db');
const wallet = require('../services/walletService');
const gateway = require('../services/smsgw/gateway');
const { isPlatformAdminEmail, startOfNextMoment, addLog } = require('../services/accessService');

const num = (v) => Number(String(v ?? '').replace(',', '.'));
const fail = (res, status, error) => res.status(status).json({ error });

async function loadReseller(req) {
  const a = await prisma.account.findUnique({ where: { id: req.userId } });
  return a && a.isReseller ? a : null;
}

/** Garante que a conta é revendedora e devolve as tarifas de atacado dela. */
async function wholesaleOf(resellerId) {
  const w = await wallet.getWallet(resellerId);
  const gw = await gateway.getGatewaySettings(resellerId);
  return { smsPerPartBrl: gw.priceBrl || 0, voiceOutPerMinBrl: w?.voiceOutPerMinBrl || 0, voiceInPerMinBrl: w?.voiceInPerMinBrl || 0, balanceBrl: w?.balanceBrl || 0 };
}

exports.overview = async (req, res, next) => {
  try {
    const r = await loadReseller(req);
    if (!r) return fail(res, 403, 'Esta conta não é de revendedor.');
    const clients = await prisma.account.findMany({
      where: { resellerId: r.id },
      include: { members: { where: { role: 'owner' }, select: { email: true, name: true }, take: 1 }, subscriptionPlan: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    const wallets = await prisma.wallet.findMany({ where: { userId: { in: clients.map((c) => c.id) } } });
    const wm = new Map(wallets.map((w) => [w.userId, w]));
    const gws = await Promise.all(clients.map((c) => gateway.getGatewaySettings(c.id).catch(() => ({ priceBrl: 0 }))));
    const plans = await prisma.plan.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } });
    res.json({
      maxClients: r.resellerMaxClients,
      wholesale: await wholesaleOf(r.id),
      plans,
      clients: clients.map((c, i) => {
        const w = wm.get(c.id);
        return {
          id: c.id, name: c.name, ownerEmail: c.members[0]?.email || '', accessStatus: c.accessStatus,
          plan: c.subscriptionPlan?.name || c.plan || '', endsAt: c.subscriptionEndsAt,
          balanceBrl: w?.balanceBrl || 0, walletEnabled: !!w?.enabled,
          rates: { smsPerPartBrl: gws[i].priceBrl || 0, voiceOutPerMinBrl: w?.voiceOutPerMinBrl || 0, voiceInPerMinBrl: w?.voiceInPerMinBrl || 0 }
        };
      })
    });
  } catch (e) { next(e); }
};

exports.createClient = async (req, res, next) => {
  try {
    const r = await loadReseller(req);
    if (!r) return fail(res, 403, 'Esta conta não é de revendedor.');
    const { companyName, ownerName, email, password, planId, days } = req.body || {};
    if (!ownerName || !email) return fail(res, 400, 'Nome do responsável e e-mail são obrigatórios.');
    if (isPlatformAdminEmail(email)) return fail(res, 400, 'Este e-mail é reservado.');
    if (await prisma.member.findUnique({ where: { email: String(email).trim().toLowerCase() } })) return fail(res, 400, 'Já existe um usuário com este e-mail.');
    if (r.resellerMaxClients != null) {
      const n = await prisma.account.count({ where: { resellerId: r.id } });
      if (n >= r.resellerMaxClients) return fail(res, 403, `Você atingiu o limite de ${r.resellerMaxClients} clientes. Peça ao administrador para ampliar.`);
    }
    let plan = null;
    if (planId) {
      plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
      if (!plan) return fail(res, 404, 'Plano não encontrado.');
    }
    const tempPassword = password && String(password).length >= 6 ? String(password) : crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
    const now = new Date();
    const d = Number(days) > 0 ? Number(days) : 30;
    const account = await prisma.account.create({
      data: {
        name: companyName || ownerName, accessStatus: 'ativa', resellerId: r.id,
        planId: plan ? plan.id : null, plan: plan ? plan.name : null,
        subscriptionStartsAt: now, subscriptionEndsAt: startOfNextMoment(now, d),
        termsAcceptedAt: now,
        members: { create: { name: ownerName, email: String(email).trim().toLowerCase(), passwordHash: await bcrypt.hash(tempPassword, 10), role: 'owner', status: 'ativo' } }
      }
    });
    await prisma.crmBoard.create({
      data: {
        userId: account.id, name: 'Funil Principal',
        columns: { create: [
          { name: 'Novos', position: 0, color: '#00b4d8' }, { name: 'Em Qualificação', position: 1, color: '#48cae4' },
          { name: 'Qualificado', position: 2, color: '#0096c7' }, { name: 'Em Negociação', position: 3, color: '#0077b6' },
          { name: 'Fechado', position: 4, color: '#22c55e' }, { name: 'Perdido', position: 5, color: '#ef4444' }
        ] }
      }
    });
    await addLog(account.id, 'criada', `Conta criada pelo revendedor ${r.name}`, req.member?.email);
    res.status(201).json({ id: account.id, credentials: { email: String(email).trim().toLowerCase(), password: tempPassword } });
  } catch (e) { next(e); }
};

async function ownClient(req) {
  const r = await loadReseller(req);
  if (!r) return { error: [403, 'Esta conta não é de revendedor.'] };
  const c = await prisma.account.findFirst({ where: { id: req.params.id, resellerId: r.id } });
  if (!c) return { error: [404, 'Cliente não encontrado.'] };
  return { r, c };
}

exports.setStatus = async (req, res, next) => {
  try {
    const { r, c, error } = await ownClient(req);
    if (error) return fail(res, ...error);
    const block = !!req.body.blocked;
    await prisma.account.update({ where: { id: c.id }, data: { accessStatus: block ? 'bloqueada' : 'ativa' } });
    await addLog(c.id, block ? 'bloqueio' : 'desbloqueio', `${block ? 'Bloqueada' : 'Liberada'} pelo revendedor ${r.name}`, req.member?.email);
    res.json({ success: true });
  } catch (e) { next(e); }
};

exports.setRates = async (req, res, next) => {
  try {
    const { r, c, error } = await ownClient(req);
    if (error) return fail(res, ...error);
    const ws = await wholesaleOf(r.id);
    const b = req.body || {};
    const sms = num(b.smsPerPartBrl);
    const vo = num(b.voiceOutPerMinBrl);
    const vi = num(b.voiceInPerMinBrl);
    if ([sms, vo, vi].some((x) => !Number.isFinite(x) || x < 0)) return fail(res, 400, 'Valores inválidos.');
    // Piso: o revendedor nunca vende abaixo do preço de atacado dele.
    if (sms < ws.smsPerPartBrl) return fail(res, 400, `O SMS não pode ficar abaixo do seu custo de atacado (R$ ${ws.smsPerPartBrl.toFixed(4)} por parte).`);
    if (vo < ws.voiceOutPerMinBrl) return fail(res, 400, `A ligação feita não pode ficar abaixo do seu custo de atacado (R$ ${ws.voiceOutPerMinBrl.toFixed(4)}/min).`);
    if (vi < ws.voiceInPerMinBrl) return fail(res, 400, `A ligação recebida não pode ficar abaixo do seu custo de atacado (R$ ${ws.voiceInPerMinBrl.toFixed(4)}/min).`);
    await wallet.saveRates(c.id, { enabled: true, voiceOutPerMinBrl: vo, voiceInPerMinBrl: vi });
    await gateway.saveGatewaySettings(c.id, { priceBrl: sms });
    res.json({ success: true });
  } catch (e) { next(e); }
};

// Adiciona saldo à carteira do cliente. O cliente paga ao revendedor por fora (Pix etc.); o que o
// revendedor paga à plataforma é o ATACADO, cobrado da carteira dele conforme o cliente usa.
exports.transfer = async (req, res, next) => {
  try {
    const { r, c, error } = await ownClient(req);
    if (error) return fail(res, ...error);
    const amount = Math.round(num(req.body.amountBrl) * 100) / 100;
    if (!(amount > 0) || amount > 100000) return fail(res, 400, 'Informe um valor válido.');
    const cw = await wallet.getWallet(c.id);
    if (!cw || !cw.enabled) return fail(res, 400, 'Defina primeiro as tarifas do cliente (isso liga o saldo pré-pago dele).');
    await wallet.credit(c.id, amount, { type: 'recarga', description: `Saldo adicionado pelo revendedor ${r.name}`, refId: r.id });
    res.json({ success: true });
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

// ---- Administrador: marca contas como revendedoras ----
exports.adminList = async (req, res, next) => {
  try {
    const rows = await prisma.account.findMany({ where: { isReseller: true }, select: { id: true, name: true, resellerMaxClients: true } });
    const counts = await prisma.account.groupBy({ by: ['resellerId'], where: { resellerId: { not: null } }, _count: true });
    const cm = new Map(counts.map((x) => [x.resellerId, x._count]));
    const out = [];
    for (const a of rows) out.push({ ...a, clients: cm.get(a.id) || 0, wholesale: await wholesaleOf(a.id) });
    res.json({ items: out });
  } catch (e) { next(e); }
};

exports.adminSet = async (req, res, next) => {
  try {
    const acc = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!acc) return fail(res, 404, 'Conta não encontrada.');
    if (acc.resellerId) return fail(res, 400, 'Esta conta é cliente de um revendedor; não pode ser revendedora.');
    const max = req.body.maxClients === '' || req.body.maxClients == null ? null : parseInt(req.body.maxClients, 10);
    if (max !== null && !(max >= 0)) return fail(res, 400, 'Limite inválido.');
    await prisma.account.update({ where: { id: acc.id }, data: { isReseller: !!req.body.isReseller, resellerMaxClients: max } });
    res.json({ success: true });
  } catch (e) { next(e); }
};
