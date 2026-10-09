// backend/src/controllers/teamController.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/db');
const { checkLimit } = require('../services/planService');

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

function serializeMember(member) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    agentId: member.agentId,
    agent: member.agent || null,
    lastLoginAt: member.lastLoginAt,
    createdAt: member.createdAt
  };
}

exports.list = async (req, res, next) => {
  try {
    const members = await prisma.member.findMany({
      where: { accountId: req.userId },
      orderBy: { createdAt: 'asc' },
      include: { agent: { select: { id: true, name: true, phoneNumber: true } } }
    });
    res.json({ members: members.map(serializeMember) });
  } catch (error) {
    next(error);
  }
};

exports.invite = async (req, res, next) => {
  try {
    const { name, email, role, agentId } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Nome e e-mail são obrigatórios' });
    }
    if (role && !['admin', 'vendedor'].includes(role)) {
      return res.status(400).json({ error: 'role deve ser "admin" ou "vendedor"' });
    }

    const limit = await checkLimit(req.userId, 'members');
    if (!limit.ok) {
      return res.status(403).json({ error: limit.message, code: 'PLAN_LIMIT' });
    }

    const existing = await prisma.member.findFirst({ where: { email: { equals: String(email).trim(), mode: 'insensitive' } } });
    if (existing) {
      return res.status(400).json({ error: 'Já existe um usuário com este e-mail' });
    }

    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: req.userId } });
      if (!agent) {
        return res.status(404).json({ error: 'Vendedor (telefone) informado não foi encontrado em Linhas' });
      }
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const member = await prisma.member.create({
      data: {
        accountId: req.userId,
        name,
        email,
        passwordHash,
        role: role || 'vendedor',
        agentId: agentId || null,
        status: 'ativo'
      },
      include: { agent: { select: { id: true, name: true, phoneNumber: true } } }
    });

    res.status(201).json({
      member: serializeMember(member),
      tempPassword,
      note: 'Compartilhe esta senha temporária com o novo usuário por um canal seguro. Ela não será mostrada novamente.'
    });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const member = await prisma.member.findFirst({ where: { id: req.params.id, accountId: req.userId } });
    if (!member) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const { name, role, status, agentId } = req.body;

    if (role && !['owner', 'admin', 'vendedor'].includes(role)) {
      return res.status(400).json({ error: 'role inválido' });
    }
    if (member.role === 'owner' && role && role !== 'owner') {
      const ownersCount = await prisma.member.count({ where: { accountId: req.userId, role: 'owner' } });
      if (ownersCount <= 1) {
        return res.status(400).json({ error: 'A conta precisa ter pelo menos um usuário "owner"' });
      }
    }
    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: req.userId } });
      if (!agent) {
        return res.status(404).json({ error: 'Vendedor (telefone) informado não foi encontrado em Linhas' });
      }
    }

    const updated = await prisma.member.update({
      where: { id: member.id },
      data: {
        ...(name ? { name } : {}),
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
        ...(agentId !== undefined ? { agentId: agentId || null } : {})
      },
      include: { agent: { select: { id: true, name: true, phoneNumber: true } } }
    });

    res.json({ member: serializeMember(updated) });
  } catch (error) {
    next(error);
  }
};

/**
 * Administrador define uma nova senha temporária diretamente para o membro,
 * sem depender de e-mail configurado na conta.
 */
exports.resetMemberPassword = async (req, res, next) => {
  try {
    const member = await prisma.member.findFirst({ where: { id: req.params.id, accountId: req.userId } });
    if (!member) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await prisma.member.update({
      where: { id: member.id },
      data: { passwordHash, resetToken: null, resetTokenExpiresAt: null }
    });

    res.json({
      success: true,
      tempPassword,
      note: 'Compartilhe esta nova senha temporária com o usuário por um canal seguro.'
    });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const member = await prisma.member.findFirst({ where: { id: req.params.id, accountId: req.userId } });
    if (!member) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    if (member.role === 'owner') {
      const ownersCount = await prisma.member.count({ where: { accountId: req.userId, role: 'owner' } });
      if (ownersCount <= 1) {
        return res.status(400).json({ error: 'Não é possível remover o único usuário "owner" da conta' });
      }
    }
    if (member.id === req.memberId) {
      return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
    }

    await prisma.member.delete({ where: { id: member.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};