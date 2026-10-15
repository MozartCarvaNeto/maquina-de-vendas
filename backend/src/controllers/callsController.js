// backend/src/controllers/callsController.js
const axios = require('axios');
const prisma = require('../config/db');
const env = require('../config/env');
const { toE164BR } = require('../utils/phone');
const { markAccountAutoDial } = require('../jobs/dialerAutoJob');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { getCredentials, saveCredentials } = require('../services/integrationFactory');
const {
  startNextCall,
  loadListIntoQueue,
  getQueueStatus,
  pickNextCallerNumber,
  claimFreeAgent,
  releaseAgent,
  updateDialerSettings
} = require('../services/dialerQueueService');

exports.saveDialerSettings = async (req, res, next) => {
  try {
    const { autoDialEnabled, recordCallsEnabled, autoDialListId } = req.body;

    const next_ = await updateDialerSettings(req.userId, {
      autoDialEnabled: String(!!autoDialEnabled),
      recordCallsEnabled: String(!!recordCallsEnabled),
      autoDialListId: autoDialListId ? String(autoDialListId) : 'none'
    });
    markAccountAutoDial(req.userId, next_.autoDialEnabled === 'true');

    // Ligou o modo automático com a fila vazia e uma lista escolhida: carrega a lista sozinho.
    let loaded = null;
    if (next_.autoDialEnabled === 'true' && next_.autoDialListId && next_.autoDialListId !== 'none') {
      const pending = await prisma.callQueueItem.count({ where: { userId: req.userId, status: 'pendente' } });
      if (pending === 0) loaded = await loadListIntoQueue(req.userId, next_.autoDialListId).catch(() => null);
    }

    res.json({ success: true, message: 'Configurações do discador salvas', loaded });
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
            recordCallsEnabled: settings.recordCallsEnabled === 'true',
            autoDialListId: settings.autoDialListId && settings.autoDialListId !== 'none' ? settings.autoDialListId : ''
          }
        : { autoDialEnabled: false, recordCallsEnabled: false, autoDialListId: '' }
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

exports.loadList = async (req, res, next) => {
  try {
    const { listId, replace } = req.body || {};
    if (!listId) return res.status(400).json({ error: 'Escolha uma lista.' });
    const result = await loadListIntoQueue(req.userId, String(listId), { replace: !!replace });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

/** Quem pode pausar/retomar um vendedor: o próprio vendedor (pelo seu login) ou o dono/admin da conta. */
async function resolveAgentControl(req, agentId) {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: req.userId } });
  if (!agent) return { error: 'Vendedor não encontrado', status: 404 };
  const member = await prisma.member.findUnique({ where: { id: req.memberId }, select: { agentId: true, role: true } });
  const isAdmin = member?.role === 'owner' || member?.role === 'admin' || req.isPlatformAdmin;
  if (!isAdmin && member?.agentId !== agent.id) {
    return { error: 'Você só pode pausar o seu próprio atendimento.', status: 403 };
  }
  return { agent };
}

/** Equipe de vendedores com o estado de cada um (livre, em ligação, pausado, inativo). */
exports.getTeam = async (req, res, next) => {
  try {
    const [agents, member, active] = await Promise.all([
      prisma.agent.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'asc' } }),
      prisma.member.findUnique({ where: { id: req.memberId }, select: { agentId: true, role: true } }),
      prisma.call.findMany({
        where: { userId: req.userId, roboCallCampaignId: null, aiCallCampaignId: null, status: { in: ['iniciando', 'tocando', 'atendida'] } },
        select: { agentId: true, status: true, lead: { select: { name: true } } }
      })
    ]);
    const isAdmin = member?.role === 'owner' || member?.role === 'admin' || req.isPlatformAdmin;
    res.json({
      myAgentId: member?.agentId || null,
      agents: agents.map((a) => {
        const call = active.find((c) => c.agentId === a.id);
        let state = 'livre';
        if (!a.isActive) state = 'inativo';
        else if (a.status === 'em_ligacao') state = 'em_ligacao';
        else if (a.isPaused) state = 'pausado';
        return {
          id: a.id,
          name: a.name,
          phoneNumber: a.phoneNumber,
          state,
          isPaused: a.isPaused,
          pausedAt: a.pausedAt,
          currentLead: call?.lead?.name || null,
          isMine: member?.agentId === a.id,
          canControl: isAdmin || member?.agentId === a.id
        };
      })
    });
  } catch (error) {
    next(error);
  }
};

/** Pausa/retoma UM vendedor. Os outros continuam recebendo ligações normalmente. */
exports.setAgentPause = async (req, res, next) => {
  try {
    const result = await resolveAgentControl(req, req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const paused = !!req.body.paused;
    const agent = await prisma.agent.update({
      where: { id: result.agent.id },
      data: { isPaused: paused, pausedAt: paused ? new Date() : null }
    });
    const io = global.socketIoInstance;
    if (io) io.to(`user:${req.userId}`).emit('dialer:team_changed', { agentId: agent.id, isPaused: agent.isPaused });
    res.json({ success: true, agent: { id: agent.id, isPaused: agent.isPaused } });
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

    const to = toE164BR(lead.phone);
    if (!to) {
      return res.status(400).json({ error: `Telefone do lead inválido: "${lead.phone}"` });
    }

    const callerNumber = await pickNextCallerNumber(req.userId);
    if (!callerNumber) {
      return res.status(400).json({ error: 'Nenhum número de discagem cadastrado. Acesse Linhas > Números de Discagem.' });
    }

    const agent = await claimFreeAgent(req.userId);
    if (!agent) {
      return res.status(400).json({ error: 'Nenhum vendedor livre no momento (em ligação, em pausa ou inativo). Veja a equipe na tela do Discador.' });
    }

    const provider = await getActiveTelephonyProvider(req.userId);
    const statusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/twilio`;

    let providerCallId;
    try {
      ({ providerCallId } = await provider.startCall({
        to,
        from: callerNumber.phoneNumber,
        statusCallbackUrl
      }));
    } catch (error) {
      await releaseAgent(agent.id);
      throw error;
    }

    const call = await prisma.call.create({
      data: {
        userId: req.userId,
        leadId: lead.id,
        provider: 'twilio',
        providerCallId,
        fromNumber: callerNumber.phoneNumber,
        toNumber: to,
        callerNumberId: callerNumber.id,
        agentId: agent.id,
        status: 'iniciando',
        startedAt: new Date()
      }
    });

    await Promise.all([
      prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } })
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

    // Usa o mesmo provedor das ligações (banco ou, se vazio, o .env) — antes só olhava o banco
    // e falhava com "Telefonia não configurada" quando a Twilio estava só no .env.
    const telephonyProvider = await getActiveTelephonyProvider(req.userId);
    const telephonySettings = { accountSid: telephonyProvider.accountSid, authToken: telephonyProvider.authToken };

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