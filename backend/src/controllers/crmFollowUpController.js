// backend/src/controllers/crmFollowUpController.js
//
// Retorno agendado no CRM + clientes perdidos (recuperáveis):
//  - agendar data/hora para retornar o contato com o cliente;
//  - resumo para o aviso da tela inicial (vencem hoje / atrasados);
//  - marcar "retorno feito";
//  - mandar para "Perdidos" (com motivo e data para revisitar) e reativar.
const prisma = require('../config/db');

const SP_TZ = 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 30;

const LOST_REGEX = /perdid/i;
const isLostName = (name) => LOST_REGEX.test(String(name || ''));

// Brasília não tem horário de verão desde 2019: UTC-3 fixo.
function spDayBounds(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: SP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const start = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 3, 0, 0));
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function parseFutureDate(value, { allowPastMinutes = 5 } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'Data e hora inválidas.' };
  if (date.getTime() < Date.now() - allowPastMinutes * 60 * 1000) return { error: 'Escolha uma data e hora futuras para o retorno.' };
  if (date.getTime() > Date.now() + 3 * 365 * DAY_MS) return { error: 'A data do retorno está longe demais.' };
  return { date };
}

async function findOwnedCard(req, include) {
  return prisma.crmCard.findFirst({
    where: { id: req.params.cardId, column: { board: { userId: req.userId } } },
    include: include || undefined
  });
}

function stamp(date = new Date()) {
  return date.toLocaleString('pt-BR', { timeZone: SP_TZ, dateStyle: 'short', timeStyle: 'short' });
}

function appendNote(existing, line) {
  return existing ? `${existing}\n${line}` : line;
}

function emitBoardChanged(req, card, leadName) {
  const io = req.app.get('io');
  if (io) io.to(`user:${req.userId}`).emit('crm:card_moved', { cardId: card.id, leadName, toColumnId: card.columnId });
}

// ------------------------------------------------------------------ resumo (aviso da tela inicial)

exports.summary = async (req, res, next) => {
  try {
    const now = new Date();
    const { end: endOfToday } = spDayBounds(now);
    const baseWhere = { column: { board: { userId: req.userId } }, followUpAt: { not: null } };

    const select = {
      id: true,
      followUpAt: true,
      followUpNote: true,
      column: { select: { name: true, boardId: true } },
      lead: { select: { name: true, phone: true } }
    };
    const toItem = (card, state) => ({
      cardId: card.id,
      boardId: card.column.boardId,
      columnName: card.column.name,
      isLost: isLostName(card.column.name),
      leadName: card.lead.name,
      leadPhone: card.lead.phone,
      followUpAt: card.followUpAt,
      note: card.followUpNote,
      state
    });

    const [overdueCount, todayCount, upcomingCount, due, upcoming] = await Promise.all([
      prisma.crmCard.count({ where: { ...baseWhere, followUpAt: { lt: now } } }),
      prisma.crmCard.count({ where: { ...baseWhere, followUpAt: { gte: now, lt: endOfToday } } }),
      prisma.crmCard.count({ where: { ...baseWhere, followUpAt: { gte: endOfToday, lt: new Date(endOfToday.getTime() + 6 * DAY_MS) } } }),
      prisma.crmCard.findMany({ where: { ...baseWhere, followUpAt: { lt: endOfToday } }, orderBy: { followUpAt: 'asc' }, take: MAX_ITEMS, select }),
      prisma.crmCard.findMany({
        where: { ...baseWhere, followUpAt: { gte: endOfToday, lt: new Date(endOfToday.getTime() + 6 * DAY_MS) } },
        orderBy: { followUpAt: 'asc' },
        take: 10,
        select
      })
    ]);

    res.json({
      now: now.toISOString(),
      counts: { overdue: overdueCount, today: todayCount, upcoming: upcomingCount },
      due: due.map((card) => toItem(card, new Date(card.followUpAt) < now ? 'overdue' : 'today')),
      upcoming: upcoming.map((card) => toItem(card, 'upcoming'))
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ agendar / limpar

exports.schedule = async (req, res, next) => {
  try {
    const card = await findOwnedCard(req, { lead: { select: { name: true } } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado' });

    const { followUpAt, note } = req.body || {};

    // Limpar o agendamento
    if (followUpAt === null || followUpAt === '') {
      const cleared = await prisma.crmCard.update({ where: { id: card.id }, data: { followUpAt: null, followUpNote: null } });
      return res.json({ card: cleared });
    }

    const parsed = parseFutureDate(followUpAt);
    if (parsed.error) return badRequest(res, parsed.error);

    const updated = await prisma.crmCard.update({
      where: { id: card.id },
      data: {
        followUpAt: parsed.date,
        followUpNote: note ? String(note).trim().slice(0, 300) : null
      }
    });
    res.json({ card: updated });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ retorno feito

exports.markDone = async (req, res, next) => {
  try {
    const card = await findOwnedCard(req, { lead: { select: { name: true } } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado' });

    const { note, rescheduleAt, rescheduleNote } = req.body || {};
    const data = {
      lastContactAt: new Date(),
      followUpAt: null,
      followUpNote: null,
      notes: appendNote(card.notes, `✅ Retorno feito em ${stamp()}${note ? ` — ${String(note).trim().slice(0, 300)}` : ''}`)
    };

    // Já deixa o próximo retorno agendado, se informado.
    if (rescheduleAt) {
      const parsed = parseFutureDate(rescheduleAt);
      if (parsed.error) return badRequest(res, parsed.error);
      data.followUpAt = parsed.date;
      data.followUpNote = rescheduleNote ? String(rescheduleNote).trim().slice(0, 300) : null;
    }

    const updated = await prisma.crmCard.update({ where: { id: card.id }, data });
    res.json({ card: updated });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ perdidos

async function ensureLostColumn(boardId) {
  const existing = await prisma.crmColumn.findFirst({
    where: { boardId, name: { contains: 'perdid', mode: 'insensitive' } },
    orderBy: { position: 'asc' }
  });
  if (existing) return existing;
  const last = await prisma.crmColumn.count({ where: { boardId } });
  return prisma.crmColumn.create({ data: { boardId, name: 'Perdidos', color: '#ef4444', position: last } });
}

async function moveCardToColumn(tx, card, targetColumnId) {
  const targetPosition = await tx.crmCard.count({ where: { columnId: targetColumnId } });
  await tx.crmCard.updateMany({
    where: { columnId: card.columnId, position: { gt: card.position } },
    data: { position: { decrement: 1 } }
  });
  return tx.crmCard.update({ where: { id: card.id }, data: { columnId: targetColumnId, position: targetPosition } });
}

exports.markLost = async (req, res, next) => {
  try {
    const card = await findOwnedCard(req, { column: true, lead: { select: { name: true } } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado' });

    const { reason, revisitAt } = req.body || {};
    const lostReason = reason ? String(reason).trim().slice(0, 300) : null;

    let revisit = null;
    if (revisitAt) {
      const parsed = parseFutureDate(revisitAt);
      if (parsed.error) return badRequest(res, parsed.error);
      revisit = parsed.date;
    }

    const lostColumn = await ensureLostColumn(card.column.boardId);

    const updated = await prisma.$transaction(async (tx) => {
      let current = card;
      if (card.columnId !== lostColumn.id) current = await moveCardToColumn(tx, card, lostColumn.id);
      await tx.lead.update({ where: { id: card.leadId }, data: { status: 'perdido' } });
      return tx.crmCard.update({
        where: { id: current.id },
        data: {
          lostAt: card.lostAt || new Date(),
          lostReason,
          followUpAt: revisit,
          followUpNote: revisit ? 'Revisitar este cliente (nova promoção/condição).' : null,
          notes: appendNote(card.notes, `🚫 Marcado como perdido em ${stamp()}${lostReason ? ` — ${lostReason}` : ''}${revisit ? ` (revisitar em ${stamp(revisit)})` : ''}`)
        }
      });
    });

    emitBoardChanged(req, updated, card.lead.name);
    res.json({ card: updated });
  } catch (error) {
    next(error);
  }
};

exports.reactivate = async (req, res, next) => {
  try {
    const card = await findOwnedCard(req, { column: true, lead: { select: { name: true } } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado' });

    let target = null;
    if (req.body?.targetColumnId) {
      target = await prisma.crmColumn.findFirst({
        where: { id: req.body.targetColumnId, boardId: card.column.boardId }
      });
      if (!target) return badRequest(res, 'Coluna de destino não encontrada neste quadro.');
    } else {
      target = await prisma.crmColumn.findFirst({
        where: { boardId: card.column.boardId, NOT: { name: { contains: 'perdid', mode: 'insensitive' } } },
        orderBy: { position: 'asc' }
      });
    }
    if (!target) return badRequest(res, 'Não há coluna disponível para reativar o lead.');

    const updated = await prisma.$transaction(async (tx) => {
      const moved = card.columnId === target.id ? card : await moveCardToColumn(tx, card, target.id);
      const lead = await tx.lead.findUnique({ where: { id: card.leadId }, select: { status: true } });
      if (lead?.status === 'perdido') await tx.lead.update({ where: { id: card.leadId }, data: { status: 'novo' } });
      return tx.crmCard.update({
        where: { id: moved.id },
        data: {
          lostAt: null,
          lostReason: null,
          followUpAt: null,
          followUpNote: null,
          notes: appendNote(card.notes, `♻️ Lead reativado em ${stamp()}`)
        }
      });
    });

    emitBoardChanged(req, updated, card.lead.name);
    res.json({ card: updated });
  } catch (error) {
    next(error);
  }
};

module.exports.isLostName = isLostName;
module.exports.ensureLostColumn = ensureLostColumn;
