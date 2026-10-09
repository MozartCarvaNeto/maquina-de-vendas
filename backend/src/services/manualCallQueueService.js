// backend/src/services/manualCallQueueService.js
//
// Discagem manual: o vendedor liga com o próprio telefone (celular ou
// computador), e o sistema só organiza a ordem e anota o resultado — nenhuma
// ligação é feita pelo backend aqui, ao contrário das Ligações Robô.
const prisma = require('../config/db');

const SNOOZE_DAYS = 90; // "pausar contato por 3 meses"

function serializeMembership(row) {
  // Snapshot leve — guarda só os campos que esta tela muda, pra poder
  // desfazer sem carregar o registro inteiro de novo. addedAt entra aqui
  // porque, se o contato for removido e depois desfeito, ele precisa
  // reaparecer na mesma posição relativa de antes (não no fim da fila).
  return {
    id: row.id,
    addedAt: row.addedAt,
    queuePosition: row.queuePosition,
    snoozedUntil: row.snoozedUntil,
    lastOutcome: row.lastOutcome,
    lastCallAt: row.lastCallAt
  };
}

/** Próximo contato da fila: menor posição, disponível agora (sem soneca) e ainda não resolvido. */
async function getQueueState(userId, listId) {
  const list = await prisma.leadList.findFirst({ where: { id: listId, userId } });
  if (!list) {
    const err = new Error('Lista não encontrada.');
    err.status = 404;
    throw err;
  }

  const now = new Date();
  const baseWhere = { listId, list: { userId } };

  const [current, remaining, snoozed, done, pendingUndo] = await Promise.all([
    prisma.leadListMembership.findFirst({
      where: { ...baseWhere, lastOutcome: { in: ['novo', 'nao_atendeu'] }, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] },
      orderBy: [{ queuePosition: 'asc' }, { addedAt: 'asc' }],
      include: { lead: true }
    }),
    prisma.leadListMembership.count({
      where: { ...baseWhere, lastOutcome: { in: ['novo', 'nao_atendeu'] }, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
    }),
    prisma.leadListMembership.count({ where: { ...baseWhere, snoozedUntil: { gt: now } } }),
    prisma.leadListMembership.count({ where: { ...baseWhere, lastOutcome: 'interessado' } }),
    prisma.callQueueAction.findUnique({ where: { userId_listId: { userId, listId } } })
  ]);

  return {
    list: { id: list.id, name: list.name },
    current: current ? { membershipId: current.id, lead: current.lead, lastOutcome: current.lastOutcome } : null,
    counts: { restantes: remaining, pausados: snoozed, interessados: done },
    canUndo: !!pendingUndo
  };
}

async function resolveCrmColumn(userId, requestedColumnId) {
  if (requestedColumnId) {
    const column = await prisma.crmColumn.findFirst({ where: { id: requestedColumnId, board: { userId } } });
    if (column) return column;
  }
  const qualified = await prisma.crmColumn.findFirst({
    where: { name: { equals: 'Qualificado', mode: 'insensitive' }, board: { userId } }
  });
  if (qualified) return qualified;
  return prisma.crmColumn.findFirst({ where: { board: { userId } }, orderBy: [{ board: { createdAt: 'asc' } }, { position: 'asc' }] });
}

/** Grava (ou atualiza) o card do lead no CRM e devolve o estado anterior, pra dar pra desfazer depois. */
async function upsertCrmCardWithSnapshot(userId, lead, note, columnId) {
  const column = await resolveCrmColumn(userId, columnId);
  if (!column) return { crmCardExisted: false, crmCardSnapshot: null, columnName: null };

  const existing = await prisma.crmCard.findUnique({ where: { leadId: lead.id } });
  const snapshot = existing ? { columnId: existing.columnId, position: existing.position, notes: existing.notes } : null;

  const trimmedNote = String(note || '').trim();
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const entry = trimmedNote ? `📞 ${stamp} — ${trimmedNote}` : `📞 ${stamp} — Ligação manual: demonstrou interesse.`;
  const mergedNotes = existing?.notes ? `${existing.notes}\n${entry}` : entry;
  const cardCount = await prisma.crmCard.count({ where: { columnId: column.id } });

  await prisma.crmCard.upsert({
    where: { leadId: lead.id },
    update: { columnId: column.id, position: cardCount, notes: mergedNotes },
    create: { leadId: lead.id, columnId: column.id, position: cardCount, notes: mergedNotes }
  });

  return { crmCardExisted: !!existing, crmCardSnapshot: snapshot, columnName: column.name };
}

async function nextQueuePosition(listId) {
  const top = await prisma.leadListMembership.aggregate({ where: { listId }, _max: { queuePosition: true } });
  return (top._max.queuePosition || 0) + 1;
}

async function recordAction(userId, listId, leadId, action, membershipSnapshot, crmCardExisted, crmCardSnapshot) {
  await prisma.callQueueAction.upsert({
    where: { userId_listId: { userId, listId } },
    update: { leadId, action, membershipSnapshot, crmCardExisted, crmCardSnapshot },
    create: { userId, listId, leadId, action, membershipSnapshot, crmCardExisted, crmCardSnapshot }
  });
}

/**
 * Aplica o resultado da ligação. `outcome`:
 *  - 'nao_atendeu'          → volta pro fim da fila
 *  - 'nao_quer_remover'     → sai da lista de vez
 *  - 'nao_quer_pausar'      → some da fila por 3 meses
 *  - 'interessado'          → vai pro CRM com a anotação; sai da fila
 */
async function applyOutcome(userId, listId, leadId, outcome, options = {}) {
  const membership = await prisma.leadListMembership.findFirst({
    where: { listId, leadId, list: { userId } },
    include: { lead: true }
  });
  if (!membership) {
    const err = new Error('Este contato não está mais na lista (pode já ter sido tratado em outra aba).');
    err.status = 409;
    throw err;
  }

  const snapshot = serializeMembership(membership);
  const now = new Date();

  if (outcome === 'nao_atendeu') {
    await recordAction(userId, listId, leadId, outcome, snapshot, false, null);
    await prisma.leadListMembership.update({
      where: { id: membership.id },
      data: { queuePosition: await nextQueuePosition(listId), lastOutcome: 'nao_atendeu', lastCallAt: now }
    });
  } else if (outcome === 'nao_quer_remover') {
    await recordAction(userId, listId, leadId, outcome, snapshot, false, null);
    await prisma.leadListMembership.delete({ where: { id: membership.id } });
  } else if (outcome === 'nao_quer_pausar') {
    await recordAction(userId, listId, leadId, outcome, snapshot, false, null);
    await prisma.leadListMembership.update({
      where: { id: membership.id },
      data: {
        snoozedUntil: new Date(now.getTime() + SNOOZE_DAYS * 24 * 60 * 60 * 1000),
        queuePosition: await nextQueuePosition(listId),
        lastOutcome: 'nao_quer',
        lastCallAt: now
      }
    });
  } else if (outcome === 'interessado') {
    const { crmCardExisted, crmCardSnapshot, columnName } = await upsertCrmCardWithSnapshot(
      userId,
      membership.lead,
      options.note,
      options.crmColumnId
    );
    await recordAction(userId, listId, leadId, outcome, snapshot, crmCardExisted, crmCardSnapshot);
    await prisma.leadListMembership.update({
      where: { id: membership.id },
      data: { lastOutcome: 'interessado', lastCallAt: now }
    });
    return { columnName };
  } else {
    const err = new Error('Resultado inválido.');
    err.status = 400;
    throw err;
  }

  return {};
}

/** Desfaz exatamente a última ação tomada nesta lista (um nível só). */
async function undoLastAction(userId, listId) {
  const action = await prisma.callQueueAction.findUnique({ where: { userId_listId: { userId, listId } } });
  if (!action) {
    const err = new Error('Não há nenhuma ação recente para desfazer nesta lista.');
    err.status = 400;
    throw err;
  }

  if (action.action === 'nao_quer_remover') {
    // A linha foi apagada — recria com o estado de antes.
    await prisma.leadListMembership.create({
      data: {
        listId: action.listId,
        leadId: action.leadId,
        addedAt: action.membershipSnapshot.addedAt,
        queuePosition: action.membershipSnapshot.queuePosition,
        snoozedUntil: action.membershipSnapshot.snoozedUntil,
        lastOutcome: action.membershipSnapshot.lastOutcome,
        lastCallAt: action.membershipSnapshot.lastCallAt
      }
    });
  } else {
    const membership = await prisma.leadListMembership.findFirst({
      where: { listId: action.listId, leadId: action.leadId, list: { userId } }
    });
    if (membership) {
      await prisma.leadListMembership.update({
        where: { id: membership.id },
        data: {
          queuePosition: action.membershipSnapshot.queuePosition,
          snoozedUntil: action.membershipSnapshot.snoozedUntil,
          lastOutcome: action.membershipSnapshot.lastOutcome,
          lastCallAt: action.membershipSnapshot.lastCallAt
        }
      });
    }
  }

  if (action.action === 'interessado') {
    if (action.crmCardExisted && action.crmCardSnapshot) {
      await prisma.crmCard.update({
        where: { leadId: action.leadId },
        data: {
          columnId: action.crmCardSnapshot.columnId,
          position: action.crmCardSnapshot.position,
          notes: action.crmCardSnapshot.notes
        }
      });
    } else if (!action.crmCardExisted) {
      await prisma.crmCard.deleteMany({ where: { leadId: action.leadId } });
    }
  }

  await prisma.callQueueAction.delete({ where: { id: action.id } });
  return true;
}

module.exports = { getQueueState, applyOutcome, undoLastAction, SNOOZE_DAYS };
