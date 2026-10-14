// backend/src/services/dialerQueueService.js
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('./telephony/providerFactory');

async function pickNextCallerNumber(userId) {
  return prisma.callerNumber.findFirst({
    where: { userId, isActive: true },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
  });
}

async function pickAvailableAgent(userId) {
  return prisma.agent.findFirst({
    where: { userId, isActive: true, status: 'disponivel' },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
  });
}

async function startNextCall(userId) {
  const ongoing = await prisma.call.findFirst({
    where: { userId, roboCallCampaignId: null, status: { in: ['iniciando', 'tocando', 'atendida'] } }
  });
  if (ongoing) {
    const err = new Error('Já existe uma ligação em andamento. Aguarde ela terminar.');
    err.status = 400;
    throw err;
  }

  const queueItem = await prisma.callQueueItem.findFirst({
    where: { userId, status: 'pendente' },
    orderBy: { scheduledAt: 'asc' },
    include: { lead: true }
  });
  if (!queueItem) return null;

  if (queueItem.lead.optOut) {
    await prisma.callQueueItem.update({ where: { id: queueItem.id }, data: { status: 'pulado' } });
    return startNextCall(userId);
  }

  const callerNumber = await pickNextCallerNumber(userId);
  if (!callerNumber) {
    const err = new Error('Nenhum número de discagem cadastrado. Acesse Linhas > Números de Discagem.');
    err.status = 400;
    throw err;
  }

  const agent = await pickAvailableAgent(userId);
  if (!agent) {
    const err = new Error('Nenhum vendedor disponível no momento. Verifique a tela Linhas > Vendedores.');
    err.status = 400;
    throw err;
  }

  const provider = await getActiveTelephonyProvider(userId);
  const statusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/twilio`;

  await prisma.callQueueItem.update({ where: { id: queueItem.id }, data: { status: 'discando' } });

  let providerCallId;
  try {
    const result = await provider.startCall({
      to: queueItem.lead.phone,
      from: callerNumber.phoneNumber,
      statusCallbackUrl
    });
    providerCallId = result.providerCallId;
  } catch (error) {
    // Falha real da Twilio (ex: número não verificado na conta trial) —
    // marca o item como falho COM o motivo, e não deixa a fila travada.
    await prisma.callQueueItem.update({
      where: { id: queueItem.id },
      data: { status: 'falhou', lastError: error.message, attempts: { increment: 1 } }
    });
    throw error;
  }

  const call = await prisma.call.create({
    data: {
      userId,
      leadId: queueItem.leadId,
      provider: 'twilio',
      providerCallId,
      fromNumber: callerNumber.phoneNumber,
      toNumber: queueItem.lead.phone,
      callerNumberId: callerNumber.id,
      agentId: agent.id,
      status: 'iniciando',
      startedAt: new Date()
    }
  });

  await Promise.all([
    prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } }),
    prisma.agent.update({ where: { id: agent.id }, data: { status: 'em_ligacao', lastUsedAt: new Date() } }),
    prisma.callQueueItem.update({ where: { id: queueItem.id }, data: { attempts: { increment: 1 } } })
  ]);

  return call;
}

async function getQueueStatus(userId) {
  const [pending, ongoing, agents, callerNumbers] = await Promise.all([
    prisma.callQueueItem.findMany({
      where: { userId, status: 'pendente' },
      include: { lead: { select: { name: true, phone: true } } },
      orderBy: { scheduledAt: 'asc' },
      take: 50
    }),
    prisma.call.findFirst({
      where: { userId, roboCallCampaignId: null, status: { in: ['iniciando', 'tocando', 'atendida'] } },
      include: { lead: { select: { name: true, phone: true } }, agent: true, callerNumber: true }
    }),
    prisma.agent.findMany({ where: { userId, isActive: true } }),
    prisma.callerNumber.findMany({ where: { userId, isActive: true } })
  ]);

  return {
    pendingCount: pending.length,
    pending,
    ongoingCall: ongoing,
    availableAgents: agents.filter((a) => a.status === 'disponivel').length,
    totalAgents: agents.length,
    totalCallerNumbers: callerNumbers.length
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

module.exports = { loadListIntoQueue, startNextCall, getQueueStatus, pickNextCallerNumber, pickAvailableAgent };