// backend/src/controllers/manualCallQueueController.js
const prisma = require('../config/db');
const manualCallQueueService = require('../services/manualCallQueueService');

const VALID_OUTCOMES = ['nao_atendeu', 'nao_quer_remover', 'nao_quer_pausar', 'interessado'];

exports.listAvailableLists = async (req, res, next) => {
  try {
    const lists = await prisma.leadList.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { memberships: true } } }
    });
    res.json({ lists: lists.map((l) => ({ id: l.id, name: l.name, totalContacts: l._count.memberships })) });
  } catch (error) {
    next(error);
  }
};

exports.getQueue = async (req, res, next) => {
  try {
    const state = await manualCallQueueService.getQueueState(req.userId, req.params.listId);
    res.json(state);
  } catch (error) {
    next(error);
  }
};

exports.postOutcome = async (req, res, next) => {
  try {
    const { leadId, outcome, note, crmColumnId } = req.body;
    if (!leadId || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: 'Informe leadId e um resultado válido.' });
    }
    const result = await manualCallQueueService.applyOutcome(req.userId, req.params.listId, leadId, outcome, { note, crmColumnId });
    const state = await manualCallQueueService.getQueueState(req.userId, req.params.listId);
    res.json({ ...state, ...result });
  } catch (error) {
    next(error);
  }
};

exports.undo = async (req, res, next) => {
  try {
    await manualCallQueueService.undoLastAction(req.userId, req.params.listId);
    const state = await manualCallQueueService.getQueueState(req.userId, req.params.listId);
    res.json(state);
  } catch (error) {
    next(error);
  }
};
