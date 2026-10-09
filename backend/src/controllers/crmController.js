// backend/src/controllers/crmController.js
const prisma = require('../config/db');
const { isLostName, ensureLostColumn } = require('./crmFollowUpController');

// Evita criar duas colunas "Perdidos" se duas telas abrirem o quadro ao mesmo tempo.
const lostColumnInFlight = new Map();
async function ensureLostColumnOnce(boardId) {
  if (!lostColumnInFlight.has(boardId)) {
    lostColumnInFlight.set(
      boardId,
      ensureLostColumn(boardId).finally(() => lostColumnInFlight.delete(boardId))
    );
  }
  return lostColumnInFlight.get(boardId);
}

// ==================== BOARDS ====================

exports.listBoards = async (req, res, next) => {
  try {
    const boards = await prisma.crmBoard.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ boards });
  } catch (error) {
    next(error);
  }
};

exports.getBoard = async (req, res, next) => {
  try {
    const board = await prisma.crmBoard.findFirst({
      where: { id: req.params.boardId, userId: req.userId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: { position: 'asc' },
              include: {
                lead: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    email: true,
                    status: true,
                    createdAt: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!board) {
      return res.status(404).json({ error: 'Board não encontrado' });
    }

    // Todo quadro precisa ter a coluna final de clientes perdidos (recuperáveis).
    if (!board.columns.some((column) => isLostName(column.name))) {
      const lostColumn = await ensureLostColumnOnce(board.id);
      if (!board.columns.some((column) => column.id === lostColumn.id)) {
        board.columns.push({ ...lostColumn, cards: [] });
      }
    }

    res.json({ board });
  } catch (error) {
    next(error);
  }
};

exports.createBoard = async (req, res, next) => {
  try {
    const { name, columns } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome do board é obrigatório' });
    }

    const defaultColumns = columns && Array.isArray(columns) && columns.length > 0
      ? columns.map((c, index) => ({ name: c.name, position: index, color: c.color || '#00b4d8' }))
      : [
          { name: 'Novos', position: 0, color: '#00b4d8' },
          { name: 'Em Qualificação', position: 1, color: '#48cae4' },
          { name: 'Qualificado', position: 2, color: '#0096c7' },
          { name: 'Em Negociação', position: 3, color: '#0077b6' },
          { name: 'Fechado', position: 4, color: '#22c55e' },
          { name: 'Perdido', position: 5, color: '#ef4444' }
        ];

    const board = await prisma.crmBoard.create({
      data: {
        userId: req.userId,
        name,
        columns: { create: defaultColumns }
      },
      include: { columns: { orderBy: { position: 'asc' } } }
    });

    res.status(201).json({ board });
  } catch (error) {
    next(error);
  }
};

exports.deleteBoard = async (req, res, next) => {
  try {
    const board = await prisma.crmBoard.findFirst({
      where: { id: req.params.boardId, userId: req.userId }
    });
    if (!board) {
      return res.status(404).json({ error: 'Board não encontrado' });
    }
    await prisma.crmBoard.delete({ where: { id: board.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ==================== COLUNAS ====================

exports.createColumn = async (req, res, next) => {
  try {
    const board = await prisma.crmBoard.findFirst({
      where: { id: req.params.boardId, userId: req.userId }
    });
    if (!board) {
      return res.status(404).json({ error: 'Board não encontrado' });
    }

    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Nome da coluna é obrigatório' });
    }

    const lastPosition = await prisma.crmColumn.count({ where: { boardId: board.id } });

    const column = await prisma.crmColumn.create({
      data: { boardId: board.id, name, color: color || '#00b4d8', position: lastPosition }
    });

    res.status(201).json({ column });
  } catch (error) {
    next(error);
  }
};

exports.updateColumn = async (req, res, next) => {
  try {
    const column = await prisma.crmColumn.findFirst({
      where: { id: req.params.columnId, board: { userId: req.userId } }
    });
    if (!column) {
      return res.status(404).json({ error: 'Coluna não encontrada' });
    }

    const { name, color, position } = req.body;

    const updated = await prisma.crmColumn.update({
      where: { id: column.id },
      data: {
        ...(name ? { name } : {}),
        ...(color ? { color } : {}),
        ...(position !== undefined ? { position } : {})
      }
    });

    res.json({ column: updated });
  } catch (error) {
    next(error);
  }
};

exports.deleteColumn = async (req, res, next) => {
  try {
    const column = await prisma.crmColumn.findFirst({
      where: { id: req.params.columnId, board: { userId: req.userId } }
    });
    if (!column) {
      return res.status(404).json({ error: 'Coluna não encontrada' });
    }

    const cardsCount = await prisma.crmCard.count({ where: { columnId: column.id } });
    if (cardsCount > 0) {
      return res.status(400).json({
        error: 'Não é possível excluir uma coluna que contém cards. Mova os cards antes.'
      });
    }

    await prisma.crmColumn.delete({ where: { id: column.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ==================== CARDS ====================

/**
 * Cria manualmente um card no CRM para um lead que ainda não tem card
 * (ex: contato importado sem campanha, ou você quer forçar a entrada
 * dele no funil sem passar pelo processo de qualificação automática).
 * Se o lead já tiver um card em outra coluna, ele é apenas movido.
 */
exports.createCardManually = async (req, res, next) => {
  try {
    const column = await prisma.crmColumn.findFirst({
      where: { id: req.params.columnId, board: { userId: req.userId } }
    });
    if (!column) {
      return res.status(404).json({ error: 'Coluna não encontrada' });
    }

    const { leadId } = req.body;
    if (!leadId) {
      return res.status(400).json({ error: 'leadId é obrigatório' });
    }

    const lead = await prisma.lead.findFirst({ where: { id: leadId, userId: req.userId } });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }

    const cardCount = await prisma.crmCard.count({ where: { columnId: column.id } });

    const card = await prisma.crmCard.upsert({
      where: { leadId: lead.id },
      update: { columnId: column.id, position: cardCount },
      create: { leadId: lead.id, columnId: column.id, position: cardCount }
    });

    res.status(201).json({ card });
  } catch (error) {
    next(error);
  }
};

exports.updateCard = async (req, res, next) => {
  try {
    const card = await prisma.crmCard.findFirst({
      where: { id: req.params.cardId, column: { board: { userId: req.userId } } }
    });
    if (!card) {
      return res.status(404).json({ error: 'Card não encontrado' });
    }

    const { notes, value } = req.body;

    const updated = await prisma.crmCard.update({
      where: { id: card.id },
      data: {
        ...(notes !== undefined ? { notes } : {}),
        ...(value !== undefined ? { value } : {})
      }
    });

    res.json({ card: updated });
  } catch (error) {
    next(error);
  }
};

exports.moveCard = async (req, res, next) => {
  try {
    const card = await prisma.crmCard.findFirst({
      where: { id: req.params.cardId, column: { board: { userId: req.userId } } },
      include: { column: true, lead: true }
    });
    if (!card) {
      return res.status(404).json({ error: 'Card não encontrado' });
    }

    const { targetColumnId, targetPosition } = req.body;

    const targetColumn = await prisma.crmColumn.findFirst({
      where: { id: targetColumnId, board: { userId: req.userId } }
    });
    if (!targetColumn) {
      return res.status(404).json({ error: 'Coluna de destino não encontrada' });
    }

    const sourceColumnId = card.columnId;
    const finalPosition = Number.isInteger(targetPosition) ? targetPosition : 0;

    await prisma.$transaction(async (tx) => {
      await tx.crmCard.updateMany({
        where: { columnId: sourceColumnId, position: { gt: card.position } },
        data: { position: { decrement: 1 } }
      });

      await tx.crmCard.updateMany({
        where: { columnId: targetColumnId, position: { gte: finalPosition } },
        data: { position: { increment: 1 } }
      });

      await tx.crmCard.update({
        where: { id: card.id },
        data: { columnId: targetColumnId, position: finalPosition }
      });
    });

    if (targetColumn.name.toLowerCase() === 'fechado') {
      await prisma.lead.update({ where: { id: card.leadId }, data: { status: 'fechado' } });
    }
    if (targetColumn.name.toLowerCase() === 'em negociação') {
      await prisma.lead.update({ where: { id: card.leadId }, data: { status: 'em_negociacao' } });
    }

    // Clientes perdidos: ao entrar na coluna, registra a data e marca o lead;
    // ao sair (reativar), limpa o registro e tira o status "perdido".
    const movedIntoLost = isLostName(targetColumn.name) && !isLostName(card.column.name);
    const movedOutOfLost = !isLostName(targetColumn.name) && isLostName(card.column.name);
    if (isLostName(targetColumn.name)) {
      await prisma.lead.update({ where: { id: card.leadId }, data: { status: 'perdido' } });
    }
    if (movedIntoLost) {
      await prisma.crmCard.update({ where: { id: card.id }, data: { lostAt: new Date() } });
    }
    if (movedOutOfLost) {
      await prisma.crmCard.update({ where: { id: card.id }, data: { lostAt: null, lostReason: null } });
      const keepsStatus = ['fechado', 'em negociação'].includes(targetColumn.name.toLowerCase());
      if (!keepsStatus && card.lead.status === 'perdido') {
        await prisma.lead.update({ where: { id: card.leadId }, data: { status: 'novo' } });
      }
    }

    const io = req.app.get('io');
    io.to(`user:${req.userId}`).emit('crm:card_moved', {
      cardId: card.id,
      leadName: card.lead.name,
      fromColumnId: sourceColumnId,
      toColumnId: targetColumnId,
      position: finalPosition
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.deleteCard = async (req, res, next) => {
  try {
    const card = await prisma.crmCard.findFirst({
      where: { id: req.params.cardId, column: { board: { userId: req.userId } } }
    });
    if (!card) {
      return res.status(404).json({ error: 'Card não encontrado' });
    }
    await prisma.crmCard.delete({ where: { id: card.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};