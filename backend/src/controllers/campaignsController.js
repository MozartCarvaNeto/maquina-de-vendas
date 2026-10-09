// backend/src/controllers/campaignsController.js
const prisma = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leads: true } } }
    });
    res.json({ campaigns });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }
    res.json({ campaign });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const {
      name,
      enterpriseName,
      botPrompt,
      firstMessage,
      qualificationRules,
      followUpEnabled,
      followUpDays,
      followUpMessage,
      nutritionDays
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome da campanha é obrigatório' });
    }
    if (!qualificationRules || !Array.isArray(qualificationRules.steps)) {
      return res.status(400).json({
        error: 'qualificationRules.steps é obrigatório e deve ser um array de etapas'
      });
    }

    const campaign = await prisma.campaign.create({
      data: {
        userId: req.userId,
        name,
        enterpriseName,
        botPrompt,
        firstMessage,
        qualificationRules,
        followUpEnabled: followUpEnabled ?? true,
        followUpDays: followUpDays ?? 7,
        followUpMessage,
        nutritionDays: nutritionDays ?? 30
      }
    });

    res.status(201).json({ campaign });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: req.body
    });

    res.json({ campaign: updated });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }

    await prisma.campaign.delete({ where: { id: campaign.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};