// backend/src/services/leadPipelineService.js
const prisma = require('../config/db');
const { evaluateAnswers } = require('./qualificationEngine');

/**
 * Processa o resultado da qualificação de um lead:
 * - Se qualificado: cria o card no CRM (coluna "Qualificado").
 * - Se, além disso, o lead tiver telefone e o canal preferido dele permitir
 *   ligação (preferredChannel nulo/automático OU "call"), entra também na
 *   fila de discagem automaticamente. Leads marcados como "email" ou
 *   "whatsapp", ou sem telefone, NUNCA são enfileirados para ligação —
 *   isso mantém a fila do discador limpa e otimizada para quem de fato
 *   deve ser ligado.
 * - Se desqualificado: apenas atualiza o status, sem gerar card nem ligação.
 */
async function processQualification({ leadId, answers }) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { campaign: true }
  });

  if (!lead) {
    const err = new Error('Lead não encontrado');
    err.status = 404;
    throw err;
  }

  if (lead.optOut) {
    const err = new Error('Este lead solicitou opt-out e não pode ser processado');
    err.status = 400;
    throw err;
  }

  const rules = lead.campaign ? lead.campaign.qualificationRules : null;
  const evaluation = evaluateAnswers(rules, answers);

  const updatedLead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      qualificationAnswers: answers,
      status: evaluation.qualified ? 'qualificado' : 'desqualificado'
    }
  });

  if (!evaluation.qualified) {
    return { lead: updatedLead, evaluation, crmCard: null, queued: false };
  }

  let board = await prisma.crmBoard.findFirst({
    where: { userId: lead.userId },
    include: { columns: { orderBy: { position: 'asc' } } }
  });

  if (!board) {
    board = await prisma.crmBoard.create({
      data: {
        userId: lead.userId,
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
      },
      include: { columns: { orderBy: { position: 'asc' } } }
    });
  }

  const qualifiedColumn =
    board.columns.find((c) => c.name === 'Qualificado') || board.columns[0];

  const cardCount = await prisma.crmCard.count({ where: { columnId: qualifiedColumn.id } });

  const crmCard = await prisma.crmCard.upsert({
    where: { leadId: lead.id },
    update: { columnId: qualifiedColumn.id, position: cardCount },
    create: {
      leadId: lead.id,
      columnId: qualifiedColumn.id,
      position: cardCount
    }
  });

  // Só enfileira ligação se: tem telefone E o canal preferido permite ligação
  const channelAllowsCall = !updatedLead.preferredChannel || updatedLead.preferredChannel === 'call';
  const canBeCalled = !!updatedLead.phone && channelAllowsCall;

  let queued = false;
  if (canBeCalled) {
    const existingQueueItem = await prisma.callQueueItem.findFirst({
      where: { leadId: lead.id, status: { in: ['pendente', 'discando'] } }
    });

    if (!existingQueueItem) {
      await prisma.callQueueItem.create({
        data: { userId: lead.userId, leadId: lead.id, status: 'pendente' }
      });
      queued = true;
    }
  }

  return { lead: updatedLead, evaluation, crmCard, queued, canBeCalled };
}

module.exports = { processQualification };