// backend/src/controllers/leadListController.js
const prisma = require('../config/db');
const { resolveListMembers, resolveDynamicFilter } = require('../services/leadListService');

exports.list = async (req, res, next) => {
  try {
    const lists = await prisma.leadList.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { memberships: true } } }
    });
    res.json({ lists });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const list = await prisma.leadList.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada' });
    }

    const members = await resolveListMembers(req.userId, list);

    res.json({ list, members, memberCount: members.length });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { name, description, type, filterRules, leadIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome da lista é obrigatório' });
    }
    if (!type || !['static', 'dynamic'].includes(type)) {
      return res.status(400).json({ error: 'type deve ser "static" ou "dynamic"' });
    }
    if (type === 'dynamic' && !filterRules) {
      return res.status(400).json({ error: 'filterRules é obrigatório para listas dinâmicas' });
    }

    const list = await prisma.leadList.create({
      data: {
        userId: req.userId,
        name,
        description: description || null,
        type,
        filterRules: type === 'dynamic' ? filterRules : null
      }
    });

    if (type === 'static' && Array.isArray(leadIds) && leadIds.length > 0) {
      const validLeads = await prisma.lead.findMany({
        where: { id: { in: leadIds }, userId: req.userId },
        select: { id: true }
      });

      await prisma.leadListMembership.createMany({
        data: validLeads.map((lead) => ({ listId: list.id, leadId: lead.id })),
        skipDuplicates: true
      });
    }

    res.status(201).json({ list });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const list = await prisma.leadList.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada' });
    }

    const { name, description, filterRules } = req.body;

    const updated = await prisma.leadList.update({
      where: { id: list.id },
      data: {
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(list.type === 'dynamic' && filterRules ? { filterRules } : {})
      }
    });

    res.json({ list: updated });
  } catch (error) {
    next(error);
  }
};

exports.addMembers = async (req, res, next) => {
  try {
    const list = await prisma.leadList.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada' });
    }
    if (list.type !== 'static') {
      return res.status(400).json({ error: 'Só é possível adicionar membros manualmente em listas estáticas' });
    }

    const { leadIds } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds deve ser um array não vazio' });
    }

    const validLeads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, userId: req.userId },
      select: { id: true }
    });

    await prisma.leadListMembership.createMany({
      data: validLeads.map((lead) => ({ listId: list.id, leadId: lead.id })),
      skipDuplicates: true
    });

    res.json({ success: true, added: validLeads.length });
  } catch (error) {
    next(error);
  }
};

exports.removeMember = async (req, res, next) => {
  try {
    const list = await prisma.leadList.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada' });
    }

    await prisma.leadListMembership.deleteMany({
      where: { listId: list.id, leadId: req.params.leadId }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.previewDynamicFilter = async (req, res, next) => {
  try {
    const { filterRules } = req.body;
    if (!filterRules) {
      return res.status(400).json({ error: 'filterRules é obrigatório' });
    }

    const members = await resolveDynamicFilter(req.userId, filterRules);
    res.json({ count: members.length });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const list = await prisma.leadList.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada' });
    }
    await prisma.leadList.delete({ where: { id: list.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};