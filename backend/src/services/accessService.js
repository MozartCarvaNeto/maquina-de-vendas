// backend/src/services/accessService.js
//
// ÚNICO lugar com as regras de "quem pode usar o sistema".
// Tudo (login, cada requisição, socket, jobs automáticos) pergunta aqui.
//
// A situação de uma conta é calculada EM TEMPO REAL:
//   pendente  -> cadastrou, mas você ainda não aprovou
//   bloqueada -> você bloqueou manualmente
//   expirada  -> a data de vencimento passou (e acabou a tolerância, se houver)
//   ativa     -> pode usar
// Por isso o bloqueio por prazo é automático: não depende de nenhum robô rodar.
const prisma = require('../config/db');
const env = require('../config/env');

const DAY_MS = 24 * 60 * 60 * 1000;

function isPlatformAdminEmail(email) {
  return env.superAdminEmails.includes(String(email || '').trim().toLowerCase());
}

function formatBR(date) {
  return new Date(date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/**
 * "2026-12-31" -> fim do dia 31/12 no horário de Brasília (o cliente usa o
 * sistema o dia inteiro do vencimento). Também aceita data ISO completa.
 * Vazio/null -> null (sem vencimento).
 */
function parseEndDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T23:59:59.999-03:00`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function startOfNextMoment(base, days) {
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * @param {object} account  linha de Account (precisa de accessStatus e subscriptionEndsAt)
 * @returns {{status:string, allowed:boolean, code:string|null, message:string|null,
 *            startsAt:Date|null, endsAt:Date|null, daysLeft:number|null, inGrace:boolean, plan:string|null}}
 */
function computeAccess(account, now = new Date()) {
  const endsAt = account.subscriptionEndsAt ? new Date(account.subscriptionEndsAt) : null;
  const startsAt = account.subscriptionStartsAt ? new Date(account.subscriptionStartsAt) : null;
  const daysLeft = endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS) : null;

  const base = { startsAt, endsAt, daysLeft, inGrace: false, plan: account.plan || null };

  if (account.accessStatus === 'pendente') {
    return {
      ...base,
      status: 'pendente',
      allowed: false,
      code: 'ACCESS_PENDING',
      message: 'Seu cadastro foi recebido e está aguardando aprovação. Assim que o acesso for liberado você poderá entrar.'
    };
  }

  if (account.accessStatus === 'bloqueada') {
    return {
      ...base,
      status: 'bloqueada',
      allowed: false,
      code: 'ACCESS_BLOCKED',
      message: 'O acesso desta conta está suspenso. Entre em contato com o suporte.'
    };
  }

  if (endsAt && endsAt.getTime() < now.getTime()) {
    const graceUntil = new Date(endsAt.getTime() + env.graceDays * DAY_MS);
    if (now.getTime() > graceUntil.getTime()) {
      return {
        ...base,
        status: 'expirada',
        allowed: false,
        code: 'SUBSCRIPTION_EXPIRED',
        message: `A assinatura desta conta venceu em ${formatBR(endsAt)}. Renove para voltar a usar o sistema.`
      };
    }
    return { ...base, status: 'ativa', allowed: true, code: null, message: null, inGrace: true };
  }

  return { ...base, status: 'ativa', allowed: true, code: null, message: null };
}

/**
 * Conta vencida (ou cadastro pendente) ainda pode ENTRAR, só para pagar?
 * Só vale quando a cobrança automática está ativa. Bloqueio manual nunca entra.
 */
function isPaywallEligible(access) {
  if (access.allowed) return false;
  if (!require('./billing/asaasClient').isEnabled()) return false;
  if (access.code === 'SUBSCRIPTION_EXPIRED') return true;
  if (access.code === 'ACCESS_PENDING') return env.autoActivateOnPayment;
  return false;
}

/** Atalho para quando você só tem o e-mail do membro (admin da plataforma nunca é bloqueado). */
function checkMemberAccess(member, account) {
  if (isPlatformAdminEmail(member.email)) {
    return { status: 'ativa', allowed: true, code: null, message: null, startsAt: null, endsAt: null, daysLeft: null, inGrace: false, plan: 'Administrador' };
  }
  return computeAccess(account);
}

/**
 * IDs das contas que NÃO podem usar o sistema agora.
 * Usado pelos jobs automáticos (disparos, follow-up) para pularem essas contas.
 */
async function getBlockedAccountIds() {
  const graceCutoff = new Date(Date.now() - env.graceDays * DAY_MS);
  const rows = await prisma.account.findMany({
    where: {
      OR: [{ accessStatus: { not: 'ativa' } }, { subscriptionEndsAt: { lt: graceCutoff } }]
    },
    select: { id: true, members: { select: { email: true } } }
  });
  return rows
    .filter((row) => !row.members.some((m) => isPlatformAdminEmail(m.email)))
    .map((row) => row.id);
}

/** A conta pertence ao administrador da plataforma? (só ele pode usar as chaves globais do .env) */
async function isPlatformAdminAccount(accountId) {
  if (!accountId) return false;
  const members = await prisma.member.findMany({ where: { accountId }, select: { email: true } });
  return members.some((m) => isPlatformAdminEmail(m.email));
}

async function isAccountBlocked(accountId) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { members: { select: { email: true } } }
  });
  if (!account) return true;
  if (account.members.some((m) => isPlatformAdminEmail(m.email))) return false;
  return !computeAccess(account).allowed;
}

async function addLog(accountId, action, detail, byEmail) {
  await prisma.accessLog
    .create({ data: { accountId, action, detail: detail || null, byEmail: byEmail || null } })
    .catch((err) => console.warn('Não foi possível gravar o histórico de acesso:', err.message));
}

// ---------------------------------------------------------------------------
// WhatsApp: desliga as sessões de contas bloqueadas e religa quando liberar.
// (require "preguiçoso" para evitar dependência circular com o serviço nativo)
// ---------------------------------------------------------------------------

async function suspendAccountSessions(accountId) {
  const native = require('./whatsapp/nativeWhatsappService');
  let stopped = 0;
  for (const [connectionId, ownerId] of Array.from(native.owners.entries())) {
    if (ownerId !== accountId) continue;
    const client = native.clients.get(connectionId);
    if (!client) continue;
    await native.shutdownClient(connectionId, client, { clearFiles: false }).catch(() => null);
    await native.setStatus(connectionId, 'desconectado');
    native.emitStatus(accountId, connectionId, 'desconectado', {
      message: 'Acesso da conta suspenso. A conexão foi encerrada.'
    });
    stopped += 1;
  }
  if (stopped > 0) console.log(`⏸️  ${stopped} sessão(ões) de WhatsApp encerrada(s) por bloqueio da conta ${accountId}`);
  return stopped;
}

async function resumeAccountSessions(accountId) {
  const native = require('./whatsapp/nativeWhatsappService');
  const connections = await prisma.whatsappConnection.findMany({ where: { userId: accountId } });
  let started = 0;
  for (const conn of connections) {
    if (conn.provider === 'cloud_api') continue;
    if (native.clients.has(conn.id)) continue;
    // Só religa quem tinha sessão salva (não abre QR novo sem ninguém pedir).
    const fs = require('fs');
    if (!fs.existsSync(native.sessionDirOf(conn.id))) continue;
    native.initSession({ id: conn.id, userId: accountId }).catch((err) =>
      console.error(`Erro ao religar sessão ${conn.id}:`, err.message)
    );
    started += 1;
  }
  if (started > 0) console.log(`▶️  ${started} sessão(ões) de WhatsApp religada(s) para a conta ${accountId}`);
  return started;
}

/** Garante que as contas dos administradores da plataforma estejam sempre liberadas. */
async function ensureAdminAccounts() {
  for (const email of env.superAdminEmails) {
    const member = await prisma.member.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!member) {
      console.warn(`⚠️  SUPERADMIN_EMAILS contém ${email}, mas esse usuário ainda não existe. Rode: npm run admin:create`);
      continue;
    }
    await prisma.account.update({
      where: { id: member.accountId },
      data: { accessStatus: 'ativa', subscriptionEndsAt: null, blockedReason: null }
    });
    console.log(`🛡️  Administrador da plataforma liberado: ${member.email}`);
  }
}

/**
 * Varredura periódica: encerra no servidor as sessões de WhatsApp de contas que
 * venceram/foram bloqueadas (o bloqueio de login já é imediato; isto cuida dos
 * processos que ficariam rodando em segundo plano).
 */
async function sweepBlockedAccounts() {
  const native = require('./whatsapp/nativeWhatsappService');
  const blocked = new Set(await getBlockedAccountIds());
  if (blocked.size === 0) return;
  const owners = new Set(Array.from(native.owners.values()));
  for (const accountId of owners) {
    if (blocked.has(accountId)) await suspendAccountSessions(accountId);
  }
}

module.exports = {
  isPlatformAdminEmail,
  parseEndDate,
  startOfNextMoment,
  computeAccess,
  checkMemberAccess,
  isPaywallEligible,
  getBlockedAccountIds,
  isAccountBlocked,
  isPlatformAdminAccount,
  addLog,
  suspendAccountSessions,
  resumeAccountSessions,
  ensureAdminAccounts,
  sweepBlockedAccounts,
  DAY_MS
};
