// backend/src/controllers/callsController.js
const axios = require('axios');
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { getCredentials, saveCredentials } = require('../services/integrationFactory');
const {
  startNextCall,
  getQueueStatus,
  pickNextCallerNumber,
  pickAvailableAgent
} = require('../services/dialerQueueService');

exports.saveDialerSettings = async (req, res, next) => {
  try {
    const { autoDialEnabled, recordCallsEnabled } = req.body;

    await saveCredentials(req.userId, 'dialer', 'general', {
      autoDialEnabled: String(!!autoDialEnabled),
      recordCallsEnabled: String(!!recordCallsEnabled)
    });

    res.json({ success: true, message: 'Configurações do discador salvas' });
  } catch (error) {
    next(error);
  }
};

exports.getDialerSettings = async (req, res, next) => {
  try {
    const settings = await getCredentials(req.userId, 'dialer');
    res.json({
      settings: settings
        ? {
            autoDialEnabled: settings.autoDialEnabled === 'true',
            recordCallsEnabled: settings.recordCallsEnabled === 'true'
          }
        : { autoDialEnabled: false, recordCallsEnabled: false }
    });
  } catch (error) {
    next(error);
  }
};

exports.getQueue = async (req, res, next) => {
  try {
    const status = await getQueueStatus(req.userId);
    res.json(status);
  } catch (error) {
    next(error);
  }
};

exports.startNext = async (req, res, next) => {
  try {
    const call = await startNextCall(req.userId);
    if (!call) {
      return res.json({ message: 'Fila de discagem vazia', call: null });
    }
    res.status(201).json({ call });
  } catch (error) {
    next(error);
  }
};

exports.clickToCall = async (req, res, next) => {
  try {
    const { leadId } = req.body;

    const lead = await prisma.lead.findFirst({ where: { id: leadId, userId: req.userId } });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }
    if (lead.optOut) {
      return res.status(400).json({ error: 'Este lead solicitou opt-out' });
    }
    if (!lead.phone) {
      return res.status(400).json({ error: 'Este lead não tem telefone cadastrado' });
    }

    const ongoing = await prisma.call.findFirst({
      where: { userId: req.userId, roboCallCampaignId: null, status: { in: ['iniciando', 'tocando', 'atendida'] } }
    });
    if (ongoing) {
      return res.status(400).json({ error: 'Já existe uma ligação em andamento' });
    }

    const callerNumber = await pickNextCallerNumber(req.userId);
    if (!callerNumber) {
      return res.status(400).json({ error: 'Nenhum número de discagem cadastrado. Acesse Linhas > Números de Discagem.' });
    }

    const agent = await pickAvailableAgent(req.userId);
    if (!agent) {
      return res.status(400).json({ error: 'Nenhum vendedor disponível no momento. Verifique a tela Linhas > Vendedores.' });
    }

    const provider = await getActiveTelephonyProvider(req.userId);
    const statusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/twilio`;

    const { providerCallId } = await provider.startCall({
      to: lead.phone,
      from: callerNumber.phoneNumber,
      statusCallbackUrl
    });

    const call = await prisma.call.create({
      data: {
        userId: req.userId,
        leadId: lead.id,
        provider: 'twilio',
        providerCallId,
        fromNumber: callerNumber.phoneNumber,
        toNumber: lead.phone,
        callerNumberId: callerNumber.id,
        agentId: agent.id,
        status: 'iniciando',
        startedAt: new Date()
      }
    });

    await Promise.all([
      prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } }),
      prisma.agent.update({ where: { id: agent.id }, data: { status: 'em_ligacao', lastUsedAt: new Date() } })
    ]);

    res.status(201).json({ call });
  } catch (error) {
    next(error);
  }
};

exports.hangup = async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!call) {
      return res.status(404).json({ error: 'Ligação não encontrada' });
    }

    const provider = await getActiveTelephonyProvider(req.userId);
    await provider.hangupCall({ providerCallId: call.providerCallId });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.listHistory = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20 } = req.query;
    const take = Math.min(Number(pageSize) || 20, 100);
    const skip = (Number(page) - 1) * take;

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where: { userId: req.userId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          lead: { select: { name: true, phone: true } },
          agent: { select: { name: true } },
          callerNumber: { select: { label: true, phoneNumber: true } }
        }
      }),
      prisma.call.count({ where: { userId: req.userId } })
    ]);

    res.json({ calls, total });
  } catch (error) {
    next(error);
  }
};

/**
 * Faz o proxy autenticado do arquivo de áudio gravado na Twilio, para que
 * o frontend nunca precise das credenciais Twilio para tocar a gravação.
 */
exports.getRecording = async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!call) {
      return res.status(404).json({ error: 'Ligação não encontrada' });
    }
    if (!call.recordingUrl) {
      return res.status(404).json({ error: 'Esta ligação não possui gravação disponível' });
    }

    const telephonySettings = await getCredentials(req.userId, 'telephony');
    if (!telephonySettings) {
      return res.status(400).json({ error: 'Telefonia não configurada' });
    }

    const audioUrl = `${call.recordingUrl}.mp3`;
    const response = await axios.get(audioUrl, {
      auth: { username: telephonySettings.accountSid, password: telephonySettings.authToken },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    response.data.pipe(res);
  } catch (error) {
    next(error);
  }
};