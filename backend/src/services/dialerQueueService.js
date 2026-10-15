// backend/src/services/dialerQueueService.js
//
// Discador com equipe de vendedores.
//
// Como funciona:
//  - O lead é chamado primeiro; quando ATENDE, o sistema liga para o vendedor e junta os dois numa conferência
//    (bridgeToAgent, no webhook da Twilio).
//  - Para ninguém ficar sem vendedor, CADA discagem já RESERVA um vendedor livre (status "em_ligacao"). Assim:
//      * com vários vendedores livres, o discador chama vários leads ao mesmo tempo, cada um já com "dono";
//      * com um só vendedor, só discamos de novo quando a linha dele estiver livre (a reserva é liberada
//        quando a conversa termina);
//      * vendedor em pausa (isPaused) nunca é escolhido — a pausa vale só para ele, os outros seguem.
//  - O vendedor livre há mais tempo é o escolhido (rodízio justo).
//  - O "motor" automático (jobs/dialerAutoJob.js) chama runDialerTick() a cada poucos segundos para as contas
//    com o modo automático ligado.
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('./telephony/providerFactory');
const { getCredentials, saveCredentials } = require('./integrationFactory');
const { toE164BR } = require('../utils/phone');

const ACTIVE_CALL_STATUSES = ['iniciando', 'tocando', 'atendida'];
const MAX_QUEUE_ATTEMPTS = 3; // tentativas por lead quando não atende
const RETRY_DELAY_MINUTES = 60; // intervalo entre tentativas de um mesmo lead
const AGENT_STALE_MS = 3 * 60 * 1000; // vendedor "em ligação" sem nenhuma chamada ativa há mais que isso é liberado
const RINGING_STALE_MS = 3 * 60 * 1000; // chamando há mais que isso (aviso da operadora perdido) é encerrada
const TALKING_STALE_MS = 90 * 60 * 1000; // em conversa há mais que isso também

const lastErrors = new Map(); // userId -> { message, at }
const tickLocks = new Set();

// Erros da operadora que valem para a conta inteira (não adianta tentar o próximo lead).
const FATAL_TWILIO_CODES = [20003, 21606, 21212, 21210, 21614];

const dialerCallWhere = (userId) => ({
  userId,
  roboCallCampaignId: null,
  aiCallCampaignId: null,
  status: { in: ACTIVE_CALL_STATUSES }
});

function setLastError(userId, message) {
  if (message) lastErrors.set(userId, { message, at: new Date() });
  else lastErrors.delete(userId);
}

async function pickNextCallerNumber(userId) {
  return prisma.callerNumber.findFirst({
    where: { userId, isActive: true },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
  });
}

const FREE_AGENT_WHERE = { isActive: true, isPaused: false, status: 'disponivel' };

/** Vendedor livre (ativo, sem pausa, fora de ligação), sem reservar. */
async function pickAvailableAgent(userId) {
  return prisma.agent.findFirst({
    where: { userId, ...FREE_AGENT_WHERE },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
  });
}

/** Reserva (de forma atômica) o vendedor livre há mais tempo. Devolve null se ninguém estiver livre. */
async function claimFreeAgent(userId) {
  const candidates = await prisma.agent.findMany({
    where: { userId, ...FREE_AGENT_WHERE },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } },
    take: 10
  });
  for (const agent of candidates) {
    const claim = await prisma.agent.updateMany({
      where: { id: agent.id, ...FREE_AGENT_WHERE },
      data: { status: 'em_ligacao', lastUsedAt: new Date() }
    });
    if (claim.count === 1) return agent;
  }
  return null;
}

/** Libera o vendedor — a não ser que ele ainda tenha outra ligação ativa (aviso atrasado da operadora não pode liberar quem já está em outra chamada). */
async function releaseAgent(agentId) {
  if (!agentId) return;
  const stillBusy = await prisma.call.count({ where: { agentId, status: { in: ACTIVE_CALL_STATUSES } } });
  if (stillBusy > 0) return;
  await prisma.agent.updateMany({ where: { id: agentId, status: 'em_ligacao' }, data: { status: 'disponivel' } });
}

/**
 * Encerra uma ligação do discador de qualquer jeito: tenta desligar as duas pontas na operadora (se já tinham
 * terminado, o erro é ignorado) e fecha a ligação no sistema, liberando fila e vendedor.
 * É o que faz o botão "Encerrar ligação" funcionar mesmo com ligação "presa".
 */
async function forceCloseCall(call) {
  try {
    const provider = await getActiveTelephonyProvider(call.userId);
    for (const sid of [call.providerCallId, call.agentProviderCallId]) {
      if (sid) await provider.hangupCall({ providerCallId: sid }).catch(() => {});
    }
  } catch (_) {
    /* sem provedor configurado: só fecha no sistema */
  }
  const endedAt = new Date();
  const durationSeconds = call.answeredAt ? Math.round((endedAt.getTime() - new Date(call.answeredAt).getTime()) / 1000) : 0;
  await prisma.call.update({ where: { id: call.id }, data: { status: 'encerrada', endedAt, durationSeconds } });
  await prisma.callQueueItem.updateMany({ where: { leadId: call.leadId, status: 'discando' }, data: { status: 'concluido' } });
  await releaseAgent(call.agentId);
  const io = global.socketIoInstance;
  if (io) io.to(`user:${call.userId}`).emit('call:ended', { callId: call.id, status: 'encerrada', durationSeconds });
}

/** Esvazia a fila de discagem (quem já está em ligação não é afetado). Devolve quantos saíram. */
async function clearQueue(userId) {
  const result = await prisma.callQueueItem.updateMany({
    where: { userId, status: 'pendente' },
    data: { status: 'pulado', lastError: 'Fila limpa manualmente' }
  });
  return result.count;
}

/** Para o discador: desliga o modo automático e encerra todas as ligações do discador em andamento. */
async function stopDialer(userId) {
  await updateDialerSettings(userId, { autoDialEnabled: 'false' });
  const active = await prisma.call.findMany({ where: dialerCallWhere(userId) });
  for (const call of active) await forceCloseCall(call);
  return active.length;
}

/** Pega o próximo lead da fila que já pode ser chamado (respeita o intervalo entre tentativas). */
async function claimQueueItem(userId) {
  for (let i = 0; i < 20; i += 1) {
    const item = await prisma.callQueueItem.findFirst({
      where: { userId, status: 'pendente', scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      include: { lead: true }
    });
    if (!item) return null;
    const claim = await prisma.callQueueItem.updateMany({ where: { id: item.id, status: 'pendente' }, data: { status: 'discando' } });
    if (claim.count === 1) return item;
  }
  return null;
}

/**
 * Faz UMA discagem: reserva vendedor + lead da fila e liga para o lead.
 * @returns {{status:'dialed', call}|{status:'no_agent'}|{status:'empty'}|{status:'skipped', reason}}
 * Lança erro (com .fatal = true) quando o problema é da conta (sem número de discagem, credencial inválida…).
 */
async function dialOne(userId) {
  const callerNumber = await pickNextCallerNumber(userId);
  if (!callerNumber) {
    const err = new Error('Nenhum número de discagem cadastrado. Acesse Linhas > Números de Discagem.');
    err.status = 400;
    err.fatal = true;
    throw err;
  }

  const agent = await claimFreeAgent(userId);
  if (!agent) return { status: 'no_agent' };

  const item = await claimQueueItem(userId);
  if (!item) {
    await releaseAgent(agent.id);
    return { status: 'empty' };
  }

  const lead = item.lead;
  const skip = async (reason, status = 'pulado') => {
    await prisma.callQueueItem.update({ where: { id: item.id }, data: { status, lastError: reason } });
    await releaseAgent(agent.id);
    return { status: 'skipped', reason };
  };

  if (lead.optOut) return skip('Pediu para não receber contato');
  if (lead.status === 'perdido') return skip('Lead marcado como perdido');

  const to = toE164BR(lead.phone);
  if (!to) return skip(`Telefone inválido: "${lead.phone || ''}"`, 'falhou');

  const agentPhone = toE164BR(agent.phoneNumber);
  if (!agentPhone) {
    // Problema do vendedor, não do lead: devolve o lead à fila e tira o vendedor de circulação.
    await prisma.callQueueItem.update({ where: { id: item.id }, data: { status: 'pendente' } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'disponivel', isPaused: true, pausedAt: new Date() } });
    const err = new Error(`O telefone do vendedor "${agent.name}" é inválido ("${agent.phoneNumber}"). Corrija em Linhas > Vendedores. Ele foi pausado.`);
    err.status = 400;
    throw err;
  }

  let provider;
  try {
    provider = await getActiveTelephonyProvider(userId);
  } catch (error) {
    await prisma.callQueueItem.update({ where: { id: item.id }, data: { status: 'pendente' } });
    await releaseAgent(agent.id);
    error.fatal = true;
    throw error;
  }

  const statusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/twilio`;
  let providerCallId;
  try {
    const result = await provider.startCall({ to, from: callerNumber.phoneNumber, statusCallbackUrl });
    providerCallId = result.providerCallId;
  } catch (error) {
    if (FATAL_TWILIO_CODES.includes(error.twilioCode)) {
      await prisma.callQueueItem.update({ where: { id: item.id }, data: { status: 'pendente' } });
      await releaseAgent(agent.id);
      error.fatal = true;
      throw error;
    }
    // Problema só deste número (inválido, país não liberado…): marca e segue para o próximo.
    await prisma.callQueueItem.update({
      where: { id: item.id },
      data: { status: 'falhou', lastError: error.message, attempts: { increment: 1 } }
    });
    await releaseAgent(agent.id);
    setLastError(userId, `${lead.name}: ${error.message}`);
    return { status: 'skipped', reason: error.message };
  }

  const call = await prisma.call.create({
    data: {
      userId,
      leadId: lead.id,
      provider: provider.providerName || 'twilio',
      providerCallId,
      fromNumber: callerNumber.phoneNumber,
      toNumber: to,
      callerNumberId: callerNumber.id,
      agentId: agent.id,
      status: 'iniciando',
      startedAt: new Date()
    }
  });

  await Promise.all([
    prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } }),
    prisma.callQueueItem.update({ where: { id: item.id }, data: { attempts: { increment: 1 }, lastError: null } })
  ]);

  return { status: 'dialed', call };
}

/** Botão "Iniciar próxima ligação" (modo manual). Devolve a ligação, ou null se a fila estiver vazia. */
async function startNextCall(userId) {
  for (let i = 0; i < 10; i += 1) {
    const result = await dialOne(userId);
    if (result.status === 'dialed') return result.call;
    if (result.status === 'empty') return null;
    if (result.status === 'no_agent') {
      const err = new Error('Nenhum vendedor livre agora (todos em ligação, em pausa ou inativos). Veja o painel da equipe abaixo.');
      err.status = 400;
      throw err;
    }
    // skipped: tenta o próximo lead
  }
  return null;
}

/** Libera reservas "esquecidas" (webhook perdido, servidor reiniciado) para o discador nunca travar. */
async function reconcileStale(userId) {
  const staleCalls = await prisma.call.findMany({
    where: {
      ...dialerCallWhere(userId),
      OR: [
        { status: { in: ['iniciando', 'tocando'] }, createdAt: { lt: new Date(Date.now() - RINGING_STALE_MS) } },
        { status: 'atendida', createdAt: { lt: new Date(Date.now() - TALKING_STALE_MS) } }
      ]
    }
  });
  for (const call of staleCalls) await forceCloseCall(call);

  const busy = await prisma.agent.findMany({
    where: { userId, status: 'em_ligacao', lastUsedAt: { lt: new Date(Date.now() - AGENT_STALE_MS) } },
    select: { id: true }
  });
  for (const agent of busy) {
    const active = await prisma.call.count({ where: { ...dialerCallWhere(userId), agentId: agent.id } });
    if (active === 0) await releaseAgent(agent.id);
  }
}

/**
 * Uma "batida" do motor automático para uma conta: liga para o próximo lead se houver vendedor livre.
 * Chamado a cada poucos segundos pelo job. Devolve false quando o motor deve parar (erro da conta).
 */
async function runDialerTick(userId) {
  if (tickLocks.has(userId)) return true;
  tickLocks.add(userId);
  try {
    await reconcileStale(userId);
    for (let i = 0; i < 10; i += 1) {
      const result = await dialOne(userId);
      if (result.status === 'dialed') {
        setLastError(userId, null);
        return true; // uma discagem por batida (evita rajada)
      }
      if (result.status === 'skipped') continue; // lead inválido: tenta o próximo na mesma batida
      return true; // sem vendedor livre ou fila vazia: espera a próxima batida
    }
    return true;
  } catch (error) {
    console.error(`❌ Discador automático (conta ${userId}): ${error.message}`);
    setLastError(userId, error.message);
    if (error.fatal) {
      await updateDialerSettings(userId, { autoDialEnabled: 'false' }).catch(() => {});
      return false;
    }
    return true;
  } finally {
    tickLocks.delete(userId);
  }
}

/** Altera só alguns campos das configurações do discador (as configurações são gravadas em bloco). */
async function updateDialerSettings(userId, patch) {
  const current = (await getCredentials(userId, 'dialer')) || {};
  const next = {
    autoDialEnabled: current.autoDialEnabled || 'false',
    recordCallsEnabled: current.recordCallsEnabled || 'false',
    autoDialListId: current.autoDialListId || 'none',
    ...patch
  };
  await saveCredentials(userId, 'dialer', 'general', next);
  return next;
}

async function getQueueStatus(userId) {
  await reconcileStale(userId).catch(() => {}); // fecha ligações "presas" antes de mostrar o painel
  const [pendingCount, pending, ongoingCalls, agents, callerNumbers, settings] = await Promise.all([
    prisma.callQueueItem.count({ where: { userId, status: 'pendente' } }),
    prisma.callQueueItem.findMany({
      where: { userId, status: 'pendente' },
      include: { lead: { select: { name: true, phone: true } } },
      orderBy: { scheduledAt: 'asc' },
      take: 50
    }),
    prisma.call.findMany({
      where: dialerCallWhere(userId),
      include: { lead: { select: { name: true, phone: true } }, agent: true, callerNumber: true },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.agent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include: { member: { select: { id: true, name: true } } } }),
    prisma.callerNumber.findMany({ where: { userId, isActive: true } }),
    getCredentials(userId, 'dialer')
  ]);

  const activeAgents = agents.filter((a) => a.isActive);
  const lastError = lastErrors.get(userId) || null;
  const available = activeAgents.filter((a) => a.status === 'disponivel' && !a.isPaused).length;
  // Por que o automático não está discando agora (para a tela explicar).
  let blockedReason = null;
  if (settings?.autoDialEnabled === 'true') {
    if (activeAgents.length === 0) blockedReason = 'Nenhum vendedor ativo cadastrado. Cadastre em Linhas > Vendedores (com o celular que vai receber as ligações) — sem vendedor o discador não liga.';
    else if (callerNumbers.length === 0) blockedReason = 'Nenhum número de discagem ativo. Cadastre em Linhas > Números de Discagem.';
    else if (pendingCount === 0 && ongoingCalls.length === 0) blockedReason = 'A fila está vazia. Carregue uma lista.';
    else if (available === 0 && ongoingCalls.length === 0) blockedReason = 'Todos os vendedores estão em pausa ou inativos. Retome um vendedor para voltar a discar.';
  }
  return {
    pendingCount,
    pending,
    ongoingCall: ongoingCalls[0] || null,
    ongoingCalls,
    availableAgents: available,
    blockedReason,
    totalAgents: activeAgents.length,
    totalCallerNumbers: callerNumbers.length,
    autoDialRunning: settings?.autoDialEnabled === 'true',
    lastError: lastError ? { message: lastError.message, at: lastError.at } : null
  };
}

/**
 * Carrega os contatos de uma lista na fila do discador.
 * Entram: contatos da lista com telefone, que não pediram opt-out, não estão "perdidos", não estão
 * pausados na lista, ainda não foram resolvidos (interessado/não quer) e não receberam ligação do
 * discador nas últimas 12 h. `replace` limpa antes os itens pendentes (troca de lista).
 */
async function loadListIntoQueue(userId, listId, { replace = false } = {}) {
  const list = await prisma.leadList.findFirst({ where: { id: listId, userId }, select: { id: true, name: true } });
  if (!list) {
    const err = new Error('Lista não encontrada.');
    err.status = 404;
    throw err;
  }

  if (replace) {
    await prisma.callQueueItem.updateMany({ where: { userId, status: 'pendente' }, data: { status: 'pulado' } });
  }

  const now = new Date();
  const members = await prisma.leadListMembership.findMany({
    where: {
      listId,
      lastOutcome: { in: ['novo', 'nao_atendeu'] },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
    },
    orderBy: [{ queuePosition: 'asc' }, { addedAt: 'asc' }],
    include: { lead: { select: { id: true, name: true, phone: true, optOut: true, status: true } } }
  });

  const leadIds = members.map((m) => m.leadId);
  const [queued, recent] = await Promise.all([
    prisma.callQueueItem.findMany({ where: { userId, leadId: { in: leadIds }, status: { in: ['pendente', 'discando'] } }, select: { leadId: true } }),
    prisma.call.findMany({
      where: {
        userId,
        leadId: { in: leadIds },
        roboCallCampaignId: null,
        aiCallCampaignId: null,
        createdAt: { gt: new Date(now.getTime() - 12 * 60 * 60 * 1000) }
      },
      select: { leadId: true }
    })
  ]);
  const queuedSet = new Set(queued.map((q) => q.leadId));
  const recentSet = new Set(recent.map((c) => c.leadId));

  const rows = [];
  const skipped = { semTelefone: 0, optOut: 0, perdido: 0, jaNaFila: 0, ligadoRecentemente: 0 };
  members.forEach((m) => {
    const lead = m.lead;
    if (!lead.phone) skipped.semTelefone += 1;
    else if (lead.optOut) skipped.optOut += 1;
    else if (lead.status === 'perdido') skipped.perdido += 1;
    else if (queuedSet.has(lead.id)) skipped.jaNaFila += 1;
    else if (recentSet.has(lead.id)) skipped.ligadoRecentemente += 1;
    else rows.push({ userId, leadId: lead.id, status: 'pendente', scheduledAt: new Date(now.getTime() + rows.length) });
  });

  if (rows.length) await prisma.callQueueItem.createMany({ data: rows });
  return { list, enqueued: rows.length, skipped };
}

module.exports = {
  loadListIntoQueue,
  startNextCall,
  dialOne,
  runDialerTick,
  reconcileStale,
  releaseAgent,
  forceCloseCall,
  clearQueue,
  stopDialer,
  claimFreeAgent,
  updateDialerSettings,
  getQueueStatus,
  pickNextCallerNumber,
  pickAvailableAgent,
  setLastError,
  MAX_QUEUE_ATTEMPTS,
  RETRY_DELAY_MINUTES
};
