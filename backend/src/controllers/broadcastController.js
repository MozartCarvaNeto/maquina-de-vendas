// backend/src/controllers/broadcastController.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../config/db');
const { getMessageQuota } = require('../services/planService');
const {
  executeBroadcast,
  countAudience,
  buildAudienceWhere,
  pendingLeadWhere,
  getBroadcastProgress
} = require('../services/broadcastService');

const ATTACHMENTS_ROOT = path.join(__dirname, '../../uploads/broadcast-attachments');

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function saveAttachmentsToDisk(broadcastId, files) {
  if (!files || files.length === 0) return [];

  const targetDir = path.join(ATTACHMENTS_ROOT, broadcastId);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    return files.map((file) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(targetDir, filename), file.buffer);
      return {
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype
      };
    });
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }
}

exports.list = async (req, res, next) => {
  try {
    const broadcasts = await prisma.broadcastCampaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { recipients: true, variants: true } } }
    });
    res.json({ broadcasts });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const broadcast = await prisma.broadcastCampaign.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { variants: { orderBy: { position: 'asc' } } }
    });
    if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado' });
    res.json({ broadcast });
  } catch (error) {
    next(error);
  }
};

exports.getProgress = async (req, res, next) => {
  try {
    const progress = await getBroadcastProgress(req.params.id, req.userId);
    if (!progress) return res.status(404).json({ error: 'Disparo não encontrado' });
    res.json({ progress });
  } catch (error) {
    next(error);
  }
};

exports.previewAudience = async (req, res, next) => {
  try {
    const { audienceFilter, channel } = req.body;
    // Conta no banco; não traz os leads só para contar.
    const count = await countAudience(req.userId, audienceFilter || {}, channel);
    res.json({ count });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const channel = body.channel;
    const subject = body.subject;
    const message = body.message;
    const variants = parseMaybeJson(body.variants, []);
    const audienceFilter = parseMaybeJson(body.audienceFilter, { all: true });
    const scheduleType = body.scheduleType || 'now';
    const scheduledAt = body.scheduledAt;
    const recurringInterval = body.recurringInterval;
    const emailDomainId = body.emailDomainId || null;

    if (!name || !channel) return res.status(400).json({ error: 'name e channel são obrigatórios' });
    if (!['email', 'sms', 'whatsapp'].includes(channel)) {
      return res.status(400).json({ error: 'channel deve ser "email", "sms" ou "whatsapp"' });
    }

    if (channel === 'whatsapp') {
      const cleanVariants = Array.isArray(variants)
        ? variants.map((v) => String(v || '').trim()).filter(Boolean)
        : [];
      if (cleanVariants.length === 0) {
        return res.status(400).json({ error: 'Informe pelo menos 1 variação de mensagem para o WhatsApp' });
      }
      if (cleanVariants.length > 12) {
        return res.status(400).json({ error: 'Máximo de 12 variações de mensagem por disparo' });
      }

      if (req.files?.length > 1) {
        return res.status(400).json({ error: 'No WhatsApp, anexe apenas 1 imagem JPEG.' });
      }
      if (req.files?.[0] && req.files[0].mimetype !== 'image/jpeg') {
        return res.status(400).json({ error: 'A imagem do WhatsApp deve estar no formato JPEG/JPG.' });
      }
    } else if (!message) {
      return res.status(400).json({ error: 'message é obrigatório' });
    }

    if (channel === 'email' && !subject) {
      return res.status(400).json({ error: 'subject é obrigatório para disparos por e-mail' });
    }

    if (channel === 'email' && emailDomainId) {
      const ownedDomain = await prisma.emailDomain.findFirst({ where: { id: emailDomainId, userId: req.userId } });
      if (!ownedDomain) return res.status(400).json({ error: 'O domínio de e-mail selecionado não foi encontrado.' });
    }

    if (!['now', 'scheduled', 'recurring'].includes(scheduleType)) {
      return res.status(400).json({ error: 'scheduleType inválido' });
    }

    // Cota mensal de mensagens do plano.
    const quota = await getMessageQuota(req.userId);
    if (!quota.unlimited && quota.remaining <= 0) {
      return res.status(403).json({ error: quota.message, code: 'PLAN_LIMIT' });
    }

    if (scheduleType === 'recurring' && !recurringInterval) {
      return res.status(400).json({ error: 'recurringInterval é obrigatório para disparos recorrentes' });
    }

    let scheduledDate = null;
    if (scheduleType === 'scheduled') {
      if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt é obrigatório para disparos agendados' });
      scheduledDate = new Date(scheduledAt);
      if (Number.isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ error: 'scheduledAt inválido' });
      }
    }

    const minDelaySeconds = clampInt(body.minDelaySeconds, 40, 20, 600);
    const maxDelaySeconds = Math.max(minDelaySeconds, clampInt(body.maxDelaySeconds, 100, 20, 900));
    const batchSize = clampInt(body.batchSize, 15, 5, 60);
    const batchPauseMinMinutes = clampInt(body.batchPauseMinMinutes, 6, 1, 60);
    const batchPauseMaxMinutes = Math.max(
      batchPauseMinMinutes,
      clampInt(body.batchPauseMaxMinutes, 18, 1, 120)
    );

    const cleanVariants = Array.isArray(variants)
      ? variants.map((v) => String(v || '').trim()).filter(Boolean)
      : [];

    const broadcast = await prisma.broadcastCampaign.create({
      data: {
        userId: req.userId,
        name,
        channel,
        subject: channel === 'email' ? subject : null,
        message: channel === 'whatsapp' ? '' : message,
        emailDomainId: channel === 'email' ? emailDomainId : null,
        audienceFilter: audienceFilter || { all: true },
        scheduleType,
        scheduledAt: scheduledDate,
        recurringInterval: recurringInterval || null,
        status: 'agendado',
        minDelaySeconds,
        maxDelaySeconds,
        batchSize,
        batchPauseMinMinutes,
        batchPauseMaxMinutes,
        ...(channel === 'whatsapp'
          ? {
              variants: {
                create: cleanVariants.map((variantBody, index) => ({
                  body: variantBody,
                  position: index
                }))
              }
            }
          : {})
      },
      include: { variants: { orderBy: { position: 'asc' } } }
    });

    if (req.files?.length) {
      const attachments = saveAttachmentsToDisk(broadcast.id, req.files);
      await prisma.broadcastCampaign.update({
        where: { id: broadcast.id },
        data: { attachments }
      });
      broadcast.attachments = attachments;
    }

    if (scheduleType === 'now') {
      executeBroadcast(broadcast.id).catch((err) =>
        console.error(`Erro ao executar disparo imediato ${broadcast.id}:`, err.message)
      );
    }

    res.status(201).json({ broadcast });
  } catch (error) {
    next(error);
  }
};

exports.pauseResume = async (req, res, next) => {
  try {
    const broadcast = await prisma.broadcastCampaign.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado' });

    const isPaused = broadcast.status === 'pausado';
    const newStatus = isPaused ? 'agendado' : 'pausado';

    const updated = await prisma.broadcastCampaign.update({
      where: { id: broadcast.id },
      data: {
        status: newStatus,
        ...(isPaused
          ? { runningNote: 'Retomando do ponto salvo…' }
          : { isRunning: false, runningNote: 'Pausado pelo usuário.' })
      }
    });

    if (isPaused) {
      executeBroadcast(broadcast.id).catch((err) =>
        console.error(`Erro ao retomar disparo ${broadcast.id}:`, err.message)
      );
    }

    res.json({ broadcast: updated });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const broadcast = await prisma.broadcastCampaign.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado' });

    if (broadcast.isRunning) {
      return res.status(409).json({ error: 'Pause o disparo antes de excluí-lo.' });
    }

    await prisma.broadcastCampaign.delete({ where: { id: broadcast.id } });
    fs.rm(path.join(ATTACHMENTS_ROOT, broadcast.id), { recursive: true, force: true }, () => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Lista paginada do acompanhamento do disparo.
//   ?status=enviado | falhou | pendente   (padrão: enviado)
//   ?page=1&pageSize=50
// "pendente" = contatos do público ainda não processados, na ordem em que o
// disparo vai percorrê-los: o primeiro da página 1 é o PRÓXIMO a receber.
exports.getRecipients = async (req, res, next) => {
  try {
    const broadcast = await prisma.broadcastCampaign.findFirst({
      where: { id: req.params.id, userId: req.userId },
      select: { id: true, userId: true, channel: true, audienceFilter: true }
    });
    if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado' });

    const status = ['enviado', 'falhou', 'pendente'].includes(req.query.status) ? req.query.status : 'enviado';
    const pageSize = clampInt(req.query.pageSize, 50, 10, 200);
    const page = clampInt(req.query.page, 1, 1, 100000);
    const skip = (page - 1) * pageSize;

    if (status === 'pendente') {
      const audienceWhere = await buildAudienceWhere(broadcast.userId, broadcast.audienceFilter, broadcast.channel);
      const where = pendingLeadWhere(audienceWhere, broadcast.id);
      const [total, leads] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({
          where,
          orderBy: { id: 'asc' },
          skip,
          take: pageSize,
          select: { id: true, name: true, phone: true, email: true }
        })
      ]);

      return res.json({
        status,
        page,
        pageSize,
        total,
        recipients: leads.map((lead) => ({
          leadId: lead.id,
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          status: 'pendente',
          sentAt: null,
          errorMessage: null
        }))
      });
    }

    const where = { broadcastCampaignId: broadcast.id, status };
    const [total, rows] = await Promise.all([
      prisma.broadcastRecipient.count({ where }),
      prisma.broadcastRecipient.findMany({
        where,
        orderBy: status === 'enviado' ? { sentAt: 'desc' } : { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          leadId: true,
          status: true,
          sentAt: true,
          errorMessage: true,
          lead: { select: { name: true, phone: true, email: true } }
        }
      })
    ]);

    res.json({
      status,
      page,
      pageSize,
      total,
      recipients: rows.map((r) => ({
        leadId: r.leadId,
        name: r.lead?.name || null,
        phone: r.lead?.phone || null,
        email: r.lead?.email || null,
        status: r.status,
        sentAt: r.sentAt,
        errorMessage: r.errorMessage
      }))
    });
  } catch (error) {
    next(error);
  }
};