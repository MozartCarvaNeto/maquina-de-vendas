// backend/src/controllers/roboCallController.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../config/db');
const { resolveAudience } = require('../services/broadcastService');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { validatePublicUrl, executeRoboCampaign } = require('../services/roboCallService');

const AUDIO_ROOT = path.join(__dirname, '../../uploads/robocall-audio');
const ALLOWED_EXTENSIONS = ['.mp3', '.wav'];
const DIGIT_REGEX = /^[0-9*#]$/;

function parseAudienceFilter(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('audienceFilter inválido');
    err.status = 400;
    throw err;
  }
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1';
}

function saveAudio(campaignId, file, baseName) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error('Os áudios precisam estar em MP3 ou WAV.');
    err.status = 400;
    throw err;
  }
  const dir = path.join(AUDIO_ROOT, campaignId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${baseName}${ext}`;
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  return filename;
}

exports.list = async (req, res, next) => {
  try {
    const campaigns = await prisma.roboCallCampaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ campaigns });
  } catch (error) {
    next(error);
  }
};

exports.previewAudience = async (req, res, next) => {
  try {
    const leads = await resolveAudience(req.userId, parseAudienceFilter(req.body.audienceFilter), 'sms');
    res.json({ total: leads.length, sample: leads.slice(0, 5).map((l) => ({ name: l.name, phone: l.phone })) });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da campanha.' });

    const introFile = req.files?.introAudio?.[0];
    if (!introFile) return res.status(400).json({ error: 'Envie o áudio principal (a mensagem que toca quando o lead atender).' });

    const digitInterested = String(body.digitInterested || '1');
    const digitNotInterested = String(body.digitNotInterested || '2');
    if (!DIGIT_REGEX.test(digitInterested) || !DIGIT_REGEX.test(digitNotInterested)) {
      return res.status(400).json({ error: 'As teclas precisam ser um único dígito (0-9, * ou #).' });
    }
    if (digitInterested === digitNotInterested) {
      return res.status(400).json({ error: 'As teclas de "tenho interesse" e "não tenho interesse" precisam ser diferentes.' });
    }

    const concurrency = Math.min(Math.max(Number(body.concurrency) || 1, 1), 5);
    const minDelaySeconds = Math.max(Number(body.minDelaySeconds) || 15, 0);
    const maxDelaySeconds = Math.max(Number(body.maxDelaySeconds) || 40, minDelaySeconds);

    const audienceFilter = parseAudienceFilter(body.audienceFilter);
    const audience = await resolveAudience(req.userId, audienceFilter, 'sms');
    if (audience.length === 0) return res.status(400).json({ error: 'Nenhum lead com telefone encontrado para esse público.' });

    if (body.crmColumnId) {
      const column = await prisma.crmColumn.findFirst({ where: { id: body.crmColumnId, board: { userId: req.userId } } });
      if (!column) return res.status(400).json({ error: 'A coluna do CRM escolhida não foi encontrada.' });
    }
    if (body.callerNumberId) {
      const number = await prisma.callerNumber.findFirst({ where: { id: body.callerNumberId, userId: req.userId } });
      if (!number) return res.status(400).json({ error: 'O número de discagem escolhido não foi encontrado.' });
    }

    const id = crypto.randomUUID();
    const introAudioFilename = saveAudio(id, introFile, 'intro');
    const interestedAudioFilename = saveAudio(id, req.files?.interestedAudio?.[0], 'interessado');
    const notInterestedAudioFilename = saveAudio(id, req.files?.notInterestedAudio?.[0], 'sem-interesse');

    const campaign = await prisma.roboCallCampaign.create({
      data: {
        id,
        userId: req.userId,
        name,
        audienceFilter,
        introAudioFilename,
        interestedAudioFilename,
        notInterestedAudioFilename,
        digitInterested,
        digitNotInterested,
        useSpeechRecognition: toBool(body.useSpeechRecognition, true),
        crmColumnId: body.crmColumnId || null,
        whatsappFollowupMessage: body.whatsappFollowupMessage ? String(body.whatsappFollowupMessage) : null,
        callerNumberId: body.callerNumberId || null,
        recordCallsEnabled: toBool(body.recordCallsEnabled, false),
        concurrency,
        minDelaySeconds,
        maxDelaySeconds,
        totalLeads: audience.length
      }
    });

    res.status(201).json({ campaign });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const campaign = await prisma.roboCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
    res.json({ campaign });
  } catch (error) {
    next(error);
  }
};

exports.getCalls = async (req, res, next) => {
  try {
    const campaign = await prisma.roboCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });

    const calls = await prisma.call.findMany({
      where: { roboCallCampaignId: campaign.id },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { lead: { select: { name: true, phone: true } } }
    });
    res.json({ calls });
  } catch (error) {
    next(error);
  }
};

exports.start = async (req, res, next) => {
  try {
    const campaign = await prisma.roboCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });

    validatePublicUrl();
    await getActiveTelephonyProvider(req.userId);

    const numbers = await prisma.callerNumber.count({ where: { userId: req.userId, isActive: true } });
    if (numbers === 0) {
      return res.status(400).json({ error: 'Nenhum número de discagem ativo. Cadastre em Linhas > Números de Discagem.' });
    }

    await prisma.roboCallCampaign.update({
      where: { id: campaign.id },
      data: { status: 'discando', runningNote: 'Iniciando…' }
    });

    // Roda em segundo plano — a resposta volta na hora.
    executeRoboCampaign(campaign.id).catch((err) => console.error('Erro na campanha robô:', err.message));

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.pause = async (req, res, next) => {
  try {
    const result = await prisma.roboCallCampaign.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { status: 'pausado', runningNote: 'Pausando após a ligação em andamento…' }
    });
    if (result.count === 0) return res.status(404).json({ error: 'Campanha não encontrada.' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const campaign = await prisma.roboCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
    if (campaign.isRunning || campaign.status === 'discando') {
      return res.status(400).json({ error: 'Pause a campanha antes de excluir.' });
    }
    await prisma.roboCallCampaign.delete({ where: { id: campaign.id } });
    fs.rmSync(path.join(AUDIO_ROOT, campaign.id), { recursive: true, force: true });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
