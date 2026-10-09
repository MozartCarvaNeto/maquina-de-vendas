// backend/src/controllers/adminController.js
//
// Painel do ADMINISTRADOR DA PLATAFORMA (você, vendedor do sistema):
// aprovar/bloquear clientes, controlar vencimento da assinatura, etc.
// Todas as rotas exigem auth + requirePlatformAdmin (veja admin.routes.js).
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');
const {
  computeAccess,
  isPlatformAdminEmail,
  parseEndDate,
  startOfNextMoment,
  addLog,
  suspendAccountSessions,
  resumeAccountSessions
} = require('../services/accessService');
const billing = require('../services/billing/billingService');
const { catalog, normalizeFeatures, planFeatureList, accountHasFeature } = require('../services/featureService');
const { getUsage, getAccountLimits } = require('../services/planService');

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

function serializeAccount(account) {
  const members = account.members || [];
  const owner = members.find((m) => m.role === 'owner') || members[0] || null;
  const isPlatformAdminAccount = members.some((m) => isPlatformAdminEmail(m.email));
  const access = isPlatformAdminAccount
    ? { status: 'ativa', allowed: true, startsAt: null, endsAt: null, daysLeft: null, inGrace: false, plan: 'Administrador' }
    : computeAccess(account);

  const lastLoginAt = members.reduce((latest, m) => {
    if (!m.lastLoginAt) return latest;
    return !latest || new Date(m.lastLoginAt) > new Date(latest) ? m.lastLoginAt : latest;
  }, null);

  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt,
    plan: account.subscriptionPlan?.name || account.plan,
    planId: account.planId || null,
    features: planFeatureList(account.subscriptionPlan),
    billing: {
      provider: account.billingProvider || null,
      hasSubscription: Boolean(account.billingSubscriptionId)
    },
    accessStatus: account.accessStatus,
    status: access.status, // situação REAL: pendente | ativa | expirada | bloqueada
    allowed: access.allowed,
    inGrace: access.inGrace,
    startsAt: account.subscriptionStartsAt,
    endsAt: account.subscriptionEndsAt,
    daysLeft: access.daysLeft,
    blockedReason: account.blockedReason,
    adminNotes: account.adminNotes,
    isPlatformAdminAccount,
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    memberCount: members.length,
    lastLoginAt,
    counts: account._count
      ? { whatsapp: account._count.whatsappConns, leads: account._count.leads }
      : undefined
  };
}

const STATUS_ORDER = { pendente: 0, expirada: 1, ativa: 2, bloqueada: 3 };

async function loadAccount(id) {
  return prisma.account.findUnique({
    where: { id },
    include: {
      subscriptionPlan: true,
      members: {
        select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' }
      },
      _count: { select: { whatsappConns: true, leads: true } }
    }
  });
}

/** Depois de qualquer mudança: religa ou desliga o WhatsApp conforme a nova situação. */
async function syncSessions(account) {
  const fresh = await loadAccount(account.id);
  const serialized = serializeAccount(fresh);
  if (serialized.allowed) await resumeAccountSessions(account.id).catch(() => null);
  else await suspendAccountSessions(account.id).catch(() => null);
  return serialized;
}

/** Se o plano da conta não inclui WhatsApp (conexões), derruba as sessões abertas. */
async function enforceWhatsappModule(accounts) {
  for (const { id } of accounts) {
    try {
      if (!(await accountHasFeature(id, 'conexoes'))) await suspendAccountSessions(id);
    } catch (err) {
      console.warn('Não foi possível ajustar sessões após mudança de plano:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------

exports.overview = async (req, res, next) => {
  try {
    const accounts = await prisma.account.findMany({ include: { members: { select: { email: true, role: true, name: true, id: true, lastLoginAt: true } } } });
    const stats = { total: 0, pendente: 0, ativa: 0, expirada: 0, bloqueada: 0, expirando: 0 };
    for (const account of accounts) {
      const s = serializeAccount(account);
      if (s.isPlatformAdminAccount) continue; // a sua própria conta não conta como cliente
      stats.total += 1;
      stats[s.status] += 1;
      if (s.status === 'ativa' && s.daysLeft !== null && s.daysLeft <= 7) stats.expirando += 1;
    }
    res.json({ stats });
  } catch (error) {
    next(error);
  }
};

exports.listAccounts = async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const where = q
      ? {
          OR: [
            { name: { contains: String(q), mode: 'insensitive' } },
            { members: { some: { email: { contains: String(q), mode: 'insensitive' } } } },
            { members: { some: { name: { contains: String(q), mode: 'insensitive' } } } }
          ]
        }
      : {};

    const accounts = await prisma.account.findMany({
      where,
      include: {
        subscriptionPlan: true,
        members: {
          select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true },
          orderBy: { createdAt: 'asc' }
        },
        _count: { select: { whatsappConns: true, leads: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    let list = accounts.map(serializeAccount);

    if (status === 'expirando') {
      list = list.filter((a) => a.status === 'ativa' && a.daysLeft !== null && a.daysLeft <= 7);
    } else if (status && status !== 'todas') {
      list = list.filter((a) => a.status === status);
    }

    // Pendentes primeiro (precisam de ação), depois vencidas, ativas e bloqueadas.
    list.sort((a, b) => {
      if (a.isPlatformAdminAccount !== b.isPlatformAdminAccount) return a.isPlatformAdminAccount ? 1 : -1;
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({ accounts: list });
  } catch (error) {
    next(error);
  }
};

exports.getAccount = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const logs = await prisma.accessLog.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    const [usage, limits, payments, pendingPayment] = await Promise.all([
      getUsage(account.id),
      getAccountLimits(account.id),
      prisma.billingPayment.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 12 }),
      billing.getPendingPaymentLink(account)
    ]);

    res.json({
      account: serializeAccount(account),
      members: account.members,
      logs,
      usage,
      limits,
      payments,
      billingEnabled: billing.isEnabled(),
      pendingPayment
    });
  } catch (error) {
    next(error);
  }
};

/** Cria um cliente já com senha e prazo (venda fechada: você cadastra e entrega o login). */
exports.createAccount = async (req, res, next) => {
  try {
    const { companyName, ownerName, email, password, plan, days, endsAt, adminNotes } = req.body;

    if (!ownerName || !email) {
      return res.status(400).json({ error: 'Nome do responsável e e-mail são obrigatórios' });
    }
    if (isPlatformAdminEmail(email)) {
      return res.status(400).json({ error: 'Este e-mail é reservado ao administrador.' });
    }
    const existing = await prisma.member.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Já existe um usuário com este e-mail' });

    const tempPassword = password && String(password).length >= 6 ? String(password) : generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const now = new Date();
    let end = null;
    if (endsAt) {
      end = parseEndDate(endsAt);
      if (end === undefined) return res.status(400).json({ error: 'Data de vencimento inválida' });
    } else if (days && Number(days) > 0) {
      end = startOfNextMoment(now, Number(days));
    }

    const account = await prisma.account.create({
      data: {
        name: companyName || ownerName,
        accessStatus: 'ativa',
        plan: plan || null,
        subscriptionStartsAt: now,
        subscriptionEndsAt: end,
        adminNotes: adminNotes || null,
        members: { create: { name: ownerName, email, passwordHash, role: 'owner', status: 'ativo' } }
      }
    });

    await prisma.crmBoard.create({
      data: {
        userId: account.id,
        name: 'Funil Principal',
        columns: {
          create: [
            { name: 'Novos', position: 0, color: '#00b4d8' },
            { name: 'Em Qualificação', position: 1, color: '#48cae4' },
            { name: 'Qualificado', position: 2, color: '#0096c7' },
            { name: 'Em Negociação', position: 3, color: '#0077b6' },
            { name: 'Fechado', position: 4, color: '#22c55e' },
            { name: 'Perdido', position: 5, color: '#ef4444' }
          ]
        }
      }
    });

    await addLog(account.id, 'criada', `Conta criada pelo administrador${end ? ` (vence em ${end.toLocaleDateString('pt-BR')})` : ' (sem vencimento)'}`, req.member.email);

    const fresh = await loadAccount(account.id);
    res.status(201).json({ account: serializeAccount(fresh), credentials: { email, password: tempPassword } });
  } catch (error) {
    next(error);
  }
};

/** Edição de dados comerciais: nome, plano, observações, datas. */
exports.updateAccount = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const { name, plan, adminNotes, startsAt, endsAt } = req.body;
    const data = {};
    const changes = [];

    if (name !== undefined && String(name).trim()) { data.name = String(name).trim(); changes.push('nome'); }
    if (plan !== undefined) { data.plan = plan ? String(plan).trim() : null; changes.push('plano'); }
    if (adminNotes !== undefined) { data.adminNotes = adminNotes ? String(adminNotes) : null; changes.push('observações'); }

    if (startsAt !== undefined) {
      const parsed = startsAt ? new Date(`${String(startsAt).slice(0, 10)}T00:00:00-03:00`) : null;
      if (parsed && Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Data de início inválida' });
      data.subscriptionStartsAt = parsed;
      changes.push('início');
    }
    if (endsAt !== undefined) {
      const parsed = parseEndDate(endsAt);
      if (parsed === undefined) return res.status(400).json({ error: 'Data de vencimento inválida' });
      data.subscriptionEndsAt = parsed;
      changes.push(parsed ? `vencimento → ${parsed.toLocaleDateString('pt-BR')}` : 'vencimento → sem vencimento');
    }

    if (changes.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    await prisma.account.update({ where: { id: account.id }, data });
    await addLog(account.id, 'editada', `Alterado: ${changes.join(', ')}`, req.member.email);

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

/** Aprova um cadastro pendente (ou reativa) definindo por quantos dias vale. */
exports.approve = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const { days, endsAt, plan, unlimited } = req.body;
    const now = new Date();

    let end;
    if (unlimited) {
      end = null;
    } else if (endsAt) {
      end = parseEndDate(endsAt);
      if (end === undefined) return res.status(400).json({ error: 'Data de vencimento inválida' });
    } else {
      const d = Number(days) > 0 ? Number(days) : 30;
      end = startOfNextMoment(now, d);
    }

    await prisma.account.update({
      where: { id: account.id },
      data: {
        accessStatus: 'ativa',
        blockedReason: null,
        subscriptionStartsAt: account.subscriptionStartsAt || now,
        subscriptionEndsAt: end,
        ...(plan !== undefined ? { plan: plan || null } : {})
      }
    });
    await addLog(
      account.id,
      'aprovada',
      end ? `Acesso liberado até ${end.toLocaleDateString('pt-BR')}` : 'Acesso liberado sem vencimento',
      req.member.email
    );

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

/** Renovação: soma dias a partir de hoje (se já venceu) ou do vencimento atual (se ainda vale). */
exports.extend = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const days = Number(req.body.days);
    if (!days || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'Informe uma quantidade de dias entre 1 e 3650' });
    }

    const now = new Date();
    const current = account.subscriptionEndsAt ? new Date(account.subscriptionEndsAt) : null;
    const base = current && current.getTime() > now.getTime() ? current : now;
    const end = startOfNextMoment(base, days);

    await prisma.account.update({
      where: { id: account.id },
      data: { subscriptionEndsAt: end, subscriptionStartsAt: account.subscriptionStartsAt || now }
    });
    await addLog(account.id, 'renovada', `+${days} dias → vence em ${end.toLocaleDateString('pt-BR')}`, req.member.email);

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

exports.block = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });
    if (account.members.some((m) => isPlatformAdminEmail(m.email))) {
      return res.status(400).json({ error: 'A conta do administrador da plataforma não pode ser bloqueada.' });
    }

    const reason = req.body.reason ? String(req.body.reason).slice(0, 300) : null;
    await prisma.account.update({ where: { id: account.id }, data: { accessStatus: 'bloqueada', blockedReason: reason } });
    await addLog(account.id, 'bloqueada', reason || 'Sem motivo informado', req.member.email);

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

exports.unblock = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    await prisma.account.update({
      where: { id: account.id },
      data: {
        accessStatus: 'ativa',
        blockedReason: null,
        subscriptionStartsAt: account.subscriptionStartsAt || new Date()
      }
    });
    await addLog(account.id, 'desbloqueada', null, req.member.email);

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

/** Define uma senha temporária para o responsável (útil quando o cliente não recebe e-mails). */
exports.resetOwnerPassword = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const target =
      account.members.find((m) => m.id === req.body.memberId) ||
      account.members.find((m) => m.role === 'owner') ||
      account.members[0];
    if (!target) return res.status(404).json({ error: 'Nenhum usuário nesta conta' });
    if (isPlatformAdminEmail(target.email) && target.id !== req.memberId) {
      return res.status(400).json({ error: 'Não é possível redefinir a senha de outro administrador.' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await prisma.member.update({
      where: { id: target.id },
      data: { passwordHash, resetToken: null, resetTokenExpiresAt: null }
    });
    await addLog(account.id, 'senha_redefinida', `Usuário: ${target.email}`, req.member.email);

    res.json({ credentials: { email: target.email, password: tempPassword } });
  } catch (error) {
    next(error);
  }
};


// ===========================================================================
// PLANOS e COBRANÇA
// ===========================================================================

const LIMIT_FIELDS = ['maxWhatsappConnections', 'maxMembers', 'maxMonthlyMessages'];
const VALID_CYCLES = [1, 3, 6, 12];

function parsePlanBody(body, { partial }) {
  const data = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'Informe o nome do plano.' };
    data.name = name;
  }
  if (body.description !== undefined) data.description = body.description ? String(body.description).trim() : null;

  if (body.priceCents !== undefined || !partial) {
    const price = Number(body.priceCents);
    if (!Number.isInteger(price) || price < 0) return { error: 'Preço inválido.' };
    data.priceCents = price;
  }
  if (body.cycleMonths !== undefined || !partial) {
    const cycle = Number(body.cycleMonths ?? 1);
    if (!VALID_CYCLES.includes(cycle)) return { error: 'O ciclo deve ser 1 (mensal), 3, 6 ou 12 meses.' };
    data.cycleMonths = cycle;
  }

  for (const field of LIMIT_FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === '') {
      data[field] = null; // sem limite
      continue;
    }
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < 0) return { error: 'Os limites devem ser números inteiros (ou vazio para sem limite).' };
    data[field] = n;
  }

  if (body.features !== undefined) {
    const parsed = normalizeFeatures(body.features);
    if (parsed.error) return { error: parsed.error };
    data.features = parsed.features === null ? Prisma.DbNull : parsed.features;
  }

  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  if (body.isPublic !== undefined) data.isPublic = Boolean(body.isPublic);
  if (body.sortOrder !== undefined) data.sortOrder = parseInt(body.sortOrder, 10) || 0;

  return { data };
}

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
      include: { _count: { select: { accounts: true } } }
    });
    res.json({ plans, billingEnabled: billing.isEnabled(), featureCatalog: catalog() });
  } catch (error) {
    next(error);
  }
};

exports.createPlan = async (req, res, next) => {
  try {
    const { data, error } = parsePlanBody(req.body, { partial: false });
    if (error) return res.status(400).json({ error });
    res.status(201).json({ plan: await prisma.plan.create({ data }) });
  } catch (error) {
    next(error);
  }
};

exports.updatePlan = async (req, res, next) => {
  try {
    const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Plano não encontrado' });

    const { data, error } = parsePlanBody(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    const plan = await prisma.plan.update({ where: { id: existing.id }, data });
    // Mantém o rótulo de plano das contas em dia com o nome.
    if (data.name) await prisma.account.updateMany({ where: { planId: plan.id }, data: { plan: plan.name } });
    if (data.features !== undefined) await enforceWhatsappModule(await prisma.account.findMany({ where: { planId: plan.id }, select: { id: true } }));
    res.json({ plan });
  } catch (error) {
    next(error);
  }
};

/** Plano em uso é só DESATIVADO (some da vitrine; quem já tem continua). Sem uso, é apagado. */
exports.deletePlan = async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { accounts: true } } }
    });
    if (!plan) return res.status(404).json({ error: 'Plano não encontrado' });

    if (plan._count.accounts > 0) {
      await prisma.plan.update({ where: { id: plan.id }, data: { isActive: false } });
      return res.json({ deactivated: true, message: `${plan._count.accounts} conta(s) usam este plano: ele foi apenas desativado.` });
    }
    await prisma.plan.delete({ where: { id: plan.id } });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
};

/** Define o plano (e portanto os LIMITES) de uma conta, sem cobrar. */
exports.assignPlan = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const { planId } = req.body;
    let plan = null;
    if (planId) {
      plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan) return res.status(404).json({ error: 'Plano não encontrado' });
    }

    await prisma.account.update({
      where: { id: account.id },
      data: { planId: plan ? plan.id : null, ...(plan ? { plan: plan.name } : {}) }
    });
    await addLog(account.id, 'plano', plan ? `Plano definido: ${plan.name}` : 'Plano removido (sem limites)', req.member.email);
    await enforceWhatsappModule([{ id: account.id }]);

    res.json({ account: await syncSessions(account) });
  } catch (error) {
    next(error);
  }
};

/** Gera a assinatura recorrente no Asaas para o plano da conta e devolve o link de pagamento. */
exports.charge = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

    const planId = req.body.planId || account.planId;
    if (!planId) return res.status(400).json({ error: 'Defina um plano para a conta antes de gerar a cobrança.' });

    const result = await billing.checkout({
      accountId: account.id,
      planId,
      cpfCnpj: req.body.cpfCnpj,
      actorEmail: req.member.email
    });
    res.json({ payUrl: result.payUrl, reused: result.reused, account: serializeAccount(await loadAccount(account.id)) });
  } catch (error) {
    next(error);
  }
};

exports.cancelBilling = async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada' });
    const result = await billing.cancelSubscription({ accountId: account.id, actorEmail: req.member.email });
    res.json({ ...result, account: serializeAccount(await loadAccount(account.id)) });
  } catch (error) {
    next(error);
  }
};
