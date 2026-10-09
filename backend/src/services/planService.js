// backend/src/services/planService.js
//
// Limites por plano (conexões de WhatsApp, usuários, mensagens de disparos por mês).
// Regras: conta SEM plano = sem limites novos (comportamento antigo); campo de
// limite vazio no plano = sem limite; administrador da plataforma nunca é limitado.
const prisma = require('../config/db');
const { isPlatformAdminEmail, isAccountBlocked } = require('./accessService');
const { accountHasFeature } = require('./featureService');

const HARD_MAX_CONNECTIONS = 10; // teto técnico antigo, usado quando o plano não define
const METRIC_MESSAGES = 'broadcast_messages';

/** "2026-10" no horário de Brasília. */
function currentPeriod(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
}

async function getAccountLimits(accountId) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { subscriptionPlan: true, members: { select: { email: true } } }
  });
  if (!account) return null;

  const isAdmin = account.members.some((m) => isPlatformAdminEmail(m.email));
  const plan = isAdmin ? null : account.subscriptionPlan;
  return {
    planId: plan?.id || null,
    planName: plan?.name || account.plan || null,
    maxWhatsappConnections: plan?.maxWhatsappConnections ?? null,
    maxMembers: plan?.maxMembers ?? null,
    maxMonthlyMessages: plan?.maxMonthlyMessages ?? null
  };
}

async function getMessagesUsed(accountId, period = currentPeriod()) {
  const row = await prisma.usageCounter.findUnique({
    where: { accountId_period_metric: { accountId, period, metric: METRIC_MESSAGES } }
  });
  return row?.value || 0;
}

async function getUsage(accountId) {
  const [connections, members, messages] = await Promise.all([
    prisma.whatsappConnection.count({ where: { userId: accountId } }),
    prisma.member.count({ where: { accountId, status: 'ativo' } }),
    getMessagesUsed(accountId)
  ]);
  return { connections, members, messages, period: currentPeriod() };
}

/**
 * Pode criar mais um item deste tipo?
 * @param {'connections'|'members'} kind
 * @returns {{ok:boolean, limit:number|null, used:number, message?:string}}
 */
async function checkLimit(accountId, kind) {
  const limits = await getAccountLimits(accountId);
  if (!limits) return { ok: false, limit: 0, used: 0, message: 'Conta não encontrada.' };

  if (kind === 'connections') {
    const limit = limits.maxWhatsappConnections ?? HARD_MAX_CONNECTIONS;
    const used = await prisma.whatsappConnection.count({ where: { userId: accountId } });
    return used >= limit
      ? { ok: false, limit, used, message: `Limite de ${limit} conexão(ões) de WhatsApp${limits.planName ? ` do plano ${limits.planName}` : ''} atingido. Fale com o suporte para ampliar seu plano.` }
      : { ok: true, limit, used };
  }

  if (kind === 'members') {
    const limit = limits.maxMembers;
    const used = await prisma.member.count({ where: { accountId, status: 'ativo' } });
    return limit !== null && used >= limit
      ? { ok: false, limit, used, message: `Limite de ${limit} usuário(s)${limits.planName ? ` do plano ${limits.planName}` : ''} atingido. Fale com o suporte para ampliar seu plano.` }
      : { ok: true, limit, used };
  }

  throw new Error(`Tipo de limite desconhecido: ${kind}`);
}

/** Quantas mensagens de disparo ainda podem ser enviadas neste mês. */
async function getMessageQuota(accountId) {
  const limits = await getAccountLimits(accountId);
  if (!limits || limits.maxMonthlyMessages === null) {
    return { unlimited: true, limit: null, used: 0, remaining: Infinity };
  }
  const used = await getMessagesUsed(accountId);
  const remaining = Math.max(0, limits.maxMonthlyMessages - used);
  return {
    unlimited: false,
    limit: limits.maxMonthlyMessages,
    used,
    remaining,
    message: `Limite mensal de ${limits.maxMonthlyMessages} mensagens${limits.planName ? ` do plano ${limits.planName}` : ''} atingido. O limite zera no começo do próximo mês, ou fale com o suporte para ampliar seu plano.`
  };
}

/**
 * Pode enviar a PRÓXIMA mensagem de um disparo? Confere acesso da conta e cota mensal.
 * @returns {{ok:boolean, note?:string}}
 */
async function getSendGate(accountId) {
  if (await isAccountBlocked(accountId)) {
    return { ok: false, note: 'Acesso da conta suspenso (assinatura vencida ou bloqueio). O disparo foi pausado.' };
  }
  if (!(await accountHasFeature(accountId, 'disparos'))) {
    return { ok: false, note: 'O plano da conta não inclui o módulo de Disparos. O disparo foi pausado.' };
  }
  const quota = await getMessageQuota(accountId);
  if (!quota.unlimited && quota.remaining <= 0) return { ok: false, note: quota.message };
  return { ok: true };
}

/** Soma 1 ao contador do mês. Nunca derruba o envio se falhar. */
async function recordMessageSent(accountId) {
  const period = currentPeriod();
  try {
    await prisma.usageCounter.upsert({
      where: { accountId_period_metric: { accountId, period, metric: METRIC_MESSAGES } },
      update: { value: { increment: 1 } },
      create: { accountId, period, metric: METRIC_MESSAGES, value: 1 }
    });
  } catch (err) {
    console.warn('Não foi possível registrar uso mensal:', err.message);
  }
}

module.exports = {
  HARD_MAX_CONNECTIONS,
  currentPeriod,
  getAccountLimits,
  getUsage,
  checkLimit,
  getMessageQuota,
  getSendGate,
  recordMessageSent
};
