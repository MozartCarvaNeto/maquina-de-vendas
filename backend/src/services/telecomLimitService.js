// backend/src/services/telecomLimitService.js
// Limites de telefonia do PLANO: SMS por mês, minutos de voz por mês, números e agentes de IA.
// Regras iguais às do planService: conta sem plano ou campo vazio = sem limite; administrador da plataforma nunca é limitado.
const prisma = require('../config/db');
const planService = require('./planService');

const M_SMS = 'sms_parts';
const M_VOICE = 'voice_seconds';

async function limits(accountId) {
  return planService.getAccountLimits(accountId);
}

async function used(accountId, metric, period = planService.currentPeriod()) {
  const row = await prisma.usageCounter.findUnique({ where: { accountId_period_metric: { accountId, period, metric } } });
  return row?.value || 0;
}

async function add(accountId, metric, n) {
  n = Math.round(Number(n) || 0);
  if (!accountId || n <= 0) return;
  const period = planService.currentPeriod();
  try {
    await prisma.usageCounter.upsert({
      where: { accountId_period_metric: { accountId, period, metric } },
      update: { value: { increment: n } },
      create: { accountId, period, metric, value: n }
    });
  } catch (_) { /* contador nunca derruba o envio */ }
}

const planTag = (l) => (l.planName ? ` do plano ${l.planName}` : '');
const limitErr = (message) => Object.assign(new Error(message), { status: 402, configProblem: true, planLimit: true });

/** Pode enviar mais `parts` partes de SMS neste mês? Lança erro 402 se estourar. */
async function assertSms(accountId, parts = 1) {
  const l = await limits(accountId);
  if (!l || l.maxMonthlySms == null) return;
  const u = await used(accountId, M_SMS);
  if (u + parts > l.maxMonthlySms) {
    throw limitErr(`Limite mensal de ${l.maxMonthlySms} SMS${planTag(l)} atingido (${u} usados). Ele zera no começo do próximo mês, ou fale com o suporte para ampliar o plano.`);
  }
}
const recordSms = (accountId, parts) => add(accountId, M_SMS, parts);

/** Segundos de voz que ainda cabem no mês. null = sem limite. */
async function voiceSecondsLeft(accountId) {
  const l = await limits(accountId);
  if (!l || l.maxMonthlyVoiceMinutes == null) return null;
  const u = await used(accountId, M_VOICE);
  return Math.max(0, l.maxMonthlyVoiceMinutes * 60 - u);
}
const recordVoice = (accountId, seconds) => add(accountId, M_VOICE, seconds);

/** Pode ter mais um número? Devolve {ok, limit, used, message}. */
async function checkDids(accountId, extra = 1) {
  const l = await limits(accountId);
  const have = await prisma.pbxDid.count({ where: { accountId } });
  if (!l || l.maxDids == null) return { ok: true, limit: null, used: have };
  return have + extra > l.maxDids
    ? { ok: false, limit: l.maxDids, used: have, message: `O plano${l.planName ? ` ${l.planName}` : ''} permite ${l.maxDids} número(s) e a conta já tem ${have}.` }
    : { ok: true, limit: l.maxDids, used: have };
}

async function assertAiAgent(accountId) {
  const l = await limits(accountId);
  if (!l || l.maxAiAgents == null) return;
  const have = await prisma.aiVoiceAgent.count({ where: { userId: accountId } });
  if (have >= l.maxAiAgents) throw limitErr(`Limite de ${l.maxAiAgents} agente(s) de IA${planTag(l)} atingido. Fale com o suporte para ampliar o plano.`);
}

async function usage(accountId) {
  const [sms, voiceSec, dids, agents] = await Promise.all([
    used(accountId, M_SMS),
    used(accountId, M_VOICE),
    prisma.pbxDid.count({ where: { accountId } }),
    prisma.aiVoiceAgent.count({ where: { userId: accountId } })
  ]);
  return { sms, voiceMinutes: Math.ceil(voiceSec / 60), dids, aiAgents: agents };
}

module.exports = { assertSms, recordSms, voiceSecondsLeft, recordVoice, checkDids, assertAiAgent, usage, M_SMS, M_VOICE };
