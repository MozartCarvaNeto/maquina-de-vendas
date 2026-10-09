// backend/src/controllers/lineController.js
const prisma = require('../config/db');
const env = require('../config/env');

const MAX_ITEMS_PER_TYPE = 10;

// ==================== NÚMEROS DE DISCAGEM ====================

/**
 * Se a conta ainda não tem nenhum número cadastrado e o .env do servidor
 * já tem TWILIO_CALLER_NUMBER preenchido, cria automaticamente na primeira
 * vez que esta tela é aberta — assim o Discador já funciona de imediato,
 * sem exigir nenhum passo manual em Linhas.
 */
exports.listCallerNumbers = async (req, res, next) => {
  try {
    let callerNumbers = await prisma.callerNumber.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' }
    });

    if (callerNumbers.length === 0 && env.twilioCallerNumber) {
      const created = await prisma.callerNumber.create({
        data: {
          userId: req.userId,
          label: 'Número padrão (via .env)',
          phoneNumber: env.twilioCallerNumber
        }
      });
      callerNumbers = [created];
    }

    res.json({ callerNumbers, limit: MAX_ITEMS_PER_TYPE });
  } catch (error) {
    next(error);
  }
};

exports.createCallerNumber = async (req, res, next) => {
  try {
    const { label, phoneNumber } = req.body;
    if (!label || !phoneNumber) {
      return res.status(400).json({ error: 'label e phoneNumber são obrigatórios' });
    }

    const count = await prisma.callerNumber.count({ where: { userId: req.userId } });
    if (count >= MAX_ITEMS_PER_TYPE) {
      return res.status(400).json({ error: `Limite de ${MAX_ITEMS_PER_TYPE} números atingido` });
    }

    const callerNumber = await prisma.callerNumber.create({
      data: { userId: req.userId, label, phoneNumber }
    });

    res.status(201).json({ callerNumber });
  } catch (error) {
    next(error);
  }
};

exports.updateCallerNumber = async (req, res, next) => {
  try {
    const item = await prisma.callerNumber.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!item) return res.status(404).json({ error: 'Número não encontrado' });

    const { label, phoneNumber, isActive } = req.body;

    const updated = await prisma.callerNumber.update({
      where: { id: item.id },
      data: {
        ...(label !== undefined ? { label } : {}),
        ...(phoneNumber !== undefined ? { phoneNumber } : {}),
        ...(isActive !== undefined ? { isActive } : {})
      }
    });

    res.json({ callerNumber: updated });
  } catch (error) {
    next(error);
  }
};

exports.deleteCallerNumber = async (req, res, next) => {
  try {
    const item = await prisma.callerNumber.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!item) return res.status(404).json({ error: 'Número não encontrado' });
    await prisma.callerNumber.delete({ where: { id: item.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ==================== VENDEDORES (AGENTES) ====================

exports.listAgents = async (req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ agents, limit: MAX_ITEMS_PER_TYPE });
  } catch (error) {
    next(error);
  }
};

exports.createAgent = async (req, res, next) => {
  try {
    const { name, phoneNumber } = req.body;
    if (!name || !phoneNumber) {
      return res.status(400).json({ error: 'name e phoneNumber são obrigatórios' });
    }

    const count = await prisma.agent.count({ where: { userId: req.userId } });
    if (count >= MAX_ITEMS_PER_TYPE) {
      return res.status(400).json({ error: `Limite de ${MAX_ITEMS_PER_TYPE} vendedores atingido` });
    }

    const agent = await prisma.agent.create({
      data: { userId: req.userId, name, phoneNumber }
    });

    res.status(201).json({ agent });
  } catch (error) {
    next(error);
  }
};

exports.updateAgent = async (req, res, next) => {
  try {
    const item = await prisma.agent.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!item) return res.status(404).json({ error: 'Vendedor não encontrado' });

    const { name, phoneNumber, status, isActive } = req.body;

    const updated = await prisma.agent.update({
      where: { id: item.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(phoneNumber !== undefined ? { phoneNumber } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(isActive !== undefined ? { isActive } : {})
      }
    });

    res.json({ agent: updated });
  } catch (error) {
    next(error);
  }
};

exports.deleteAgent = async (req, res, next) => {
  try {
    const item = await prisma.agent.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!item) return res.status(404).json({ error: 'Vendedor não encontrado' });
    await prisma.agent.delete({ where: { id: item.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};