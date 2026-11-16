// backend/src/services/answeringMachineActions.js
//
// O que fazer quando se descobre que quem atendeu é caixa postal / secretária / triagem / URA:
// desliga na hora, registra o motivo e segue para a próxima ligação (libera o vendedor e reagenda o lead).
// Serve para o AMD da Twilio, o AMD do Asterisk e a detecção por texto. Seguro chamar mais de uma vez.
const prisma = require('../config/db');
const machines = require('./answeringMachineService');

const handled = new Map(); // callId -> timestamp (evita tratar duas vezes o mesmo aviso)

function alreadyHandled(callId) {
  const now = Date.now();
  for (const [k, t] of handled) if (now - t > 10 * 60 * 1000) handled.delete(k);
  if (handled.has(callId)) return true;
  handled.set(callId, now);
  return false;
}

/** AMD ligado? (padrão: sim; desliga com AMD_DISABLED=true no servidor ou "amdEnabled=false" nas configurações do discador). */
async function amdEnabledFor(userId, { dialer = false } = {}) {
  if (String(process.env.AMD_DISABLED || '').toLowerCase() === 'true') return false;
  if (!dialer) return true;
  try {
    const { getCredentials } = require('./integrationFactory');
    const s = await getCredentials(userId, 'dialer');
    return String(s?.amdEnabled ?? 'true') !== 'false';
  } catch (_) {
    return true;
  }
}

async function hangupLegs(call) {
  try {
    const { getActiveTelephonyProvider } = require('./telephony/providerFactory');
    const provider = await getActiveTelephonyProvider(call.userId);
    for (const sid of [call.providerCallId, call.agentProviderCallId]) {
      if (sid && !String(sid).startsWith('asterisk:')) await provider.hangupCall({ providerCallId: sid }).catch(() => {});
    }
  } catch (_) {
    /* sem provedor: a ligação já terminou */
  }
}

/**
 * @param {{ id?: string, providerCallId?: string }} ref  a ligação (por id ou pelo id da operadora)
 * @param {{ kind?: string, outcome?: string, source?: string, reason?: string }} info
 */
async function handleMachineDetected(ref, info = {}) {
  const call = await prisma.call.findFirst({
    where: ref.id ? { id: ref.id } : { providerCallId: ref.providerCallId },
    include: { aiSession: { select: { id: true, outcome: true } } }
  });
  if (!call) return { ok: false, reason: 'ligação não encontrada' };
  if (alreadyHandled(call.id)) return { ok: true, duplicate: true };

  const kind = info.kind || 'caixa_postal';
  const outcome = info.outcome || (kind === 'invalido' ? 'numero_errado' : 'caixa_postal');
  const why = `${machines.describe(kind)}${info.reason ? ` — ${info.reason}` : ''}${info.source ? ` [${info.source}]` : ''}`;
  console.log(`📵 Ligação ${call.id}: ${why}. Encerrando e indo para a próxima.`);

  await prisma.callEvent.create({ data: { callId: call.id, eventType: 'maquina_detectada', rawPayload: { kind, outcome, source: info.source || null, reason: info.reason || null } } }).catch(() => {});
  await hangupLegs(call);

  const endedAt = new Date();
  const data = { answeredBy: 'maquina' };

  if (call.aiCallCampaignId || call.aiSession) {
    // IA: o resultado vai para a sessão; o aviso de "ligação encerrada" da operadora fecha e aplica no CRM.
    if (call.aiSession && !['caixa_postal', 'numero_errado'].includes(call.aiSession.outcome || '')) {
      await prisma.aiCallSession.update({ where: { id: call.aiSession.id }, data: { outcome, callbackAt: null, callbackNote: null } }).catch(() => {});
    }
    await prisma.call.update({ where: { id: call.id }, data }).catch(() => {});
    // Asterisk não manda "completed" por este caminho: fecha agora.
    if (String(call.provider) === 'asterisk') {
      try { await require('./pbx/aiBridge').endCall(call.id, {}); } catch (_) { /* a rede de segurança fecha */ }
    }
    return { ok: true, outcome };
  }

  if (call.roboCallCampaignId) {
    // Robô: não é "resposta" de ninguém. Conta como não atendida (sem interesse/qualificação).
    await prisma.call.update({ where: { id: call.id }, data: { ...data, answeredAt: null, qualified: null } }).catch(() => {});
    return { ok: true, outcome };
  }

  // Discador com vendedor: encerra, reagenda o lead e libera o vendedor para a próxima ligação.
  const { MAX_QUEUE_ATTEMPTS, RETRY_DELAY_MINUTES, releaseAgent } = require('./dialerQueueService');
  await prisma.call.update({ where: { id: call.id }, data: { ...data, status: 'encerrada', endedAt, durationSeconds: 0 } });
  const item = await prisma.callQueueItem.findFirst({ where: { leadId: call.leadId, status: 'discando' } });
  if (item) {
    const again = item.attempts < MAX_QUEUE_ATTEMPTS && kind !== 'invalido';
    await prisma.callQueueItem.update({
      where: { id: item.id },
      data: again
        ? { status: 'pendente', scheduledAt: new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000), lastError: `${machines.describe(kind)} — tentará de novo mais tarde` }
        : { status: kind === 'invalido' ? 'falhou' : 'concluido', lastError: machines.describe(kind) }
    });
  }
  await releaseAgent(call.agentId);
  const io = global.socketIoInstance;
  if (io) io.to(`user:${call.userId}`).emit('call:ended', { callId: call.id, status: 'encerrada', machine: true, reason: machines.describe(kind) });
  return { ok: true, outcome };
}

module.exports = { handleMachineDetected, amdEnabledFor };
