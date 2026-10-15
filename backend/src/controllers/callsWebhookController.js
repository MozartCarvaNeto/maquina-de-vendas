// backend/src/controllers/callsWebhookController.js
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { getCredentials } = require('../services/integrationFactory');
const { MAX_QUEUE_ATTEMPTS, RETRY_DELAY_MINUTES, releaseAgent } = require('../services/dialerQueueService');
const { toE164BR } = require('../utils/phone');

const STATUS_MAP = {
  queued: 'iniciando',
  initiated: 'iniciando',
  ringing: 'tocando',
  'in-progress': 'atendida',
  answered: 'atendida',
  completed: 'encerrada',
  busy: 'ocupado',
  failed: 'falhou',
  'no-answer': 'sem_resposta'
};

exports.handleTwilioWebhook = async (req, res, next) => {
  try {
    const { CallSid, CallStatus } = req.body;

    const agentLegCall = await prisma.call.findFirst({ where: { agentProviderCallId: CallSid } });
    if (agentLegCall) {
      await prisma.callEvent.create({
        data: { callId: agentLegCall.id, eventType: `vendedor_${CallStatus}`, rawPayload: req.body }
      });

      if (CallStatus === 'completed') {
        const currentCall = await prisma.call.findUnique({ where: { id: agentLegCall.id } });
        await finalizeCall(currentCall);
      } else if (['no-answer', 'busy', 'failed', 'canceled'].includes(CallStatus)) {
        // O vendedor não atendeu o repasse: desliga o lead, devolve-o à fila e tira o vendedor de circulação.
        await handleAgentMissed(agentLegCall);
      }

      res.set('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    const call = await prisma.call.findFirst({ where: { providerCallId: CallSid } });
    if (!call) {
      res.set('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    await prisma.callEvent.create({
      data: { callId: call.id, eventType: CallStatus, rawPayload: req.body }
    });

    const mappedStatus = STATUS_MAP[CallStatus] || call.status;
    const updateData = { status: mappedStatus };

    if (CallStatus === 'in-progress' && call.status !== 'atendida') {
      updateData.answeredAt = new Date();
      updateData.answeredBy = 'humano';

      const lead = await prisma.lead.findUnique({ where: { id: call.leadId } });

      const io = global.socketIoInstance;
      if (io && lead) {
        io.to(`user:${call.userId}`).emit('call:answered', {
          callId: call.id,
          leadId: lead.id,
          leadName: lead.name,
          leadPhone: lead.phone
        });
      }

      if (call.agentId && call.callerNumberId) {
        const [agent, callerNumber] = await Promise.all([
          prisma.agent.findUnique({ where: { id: call.agentId } }),
          prisma.callerNumber.findUnique({ where: { id: call.callerNumberId } })
        ]);

        if (agent && callerNumber) {
          const provider = await getActiveTelephonyProvider(call.userId);
          const conferenceRoom = `call_${call.id}`;
          const statusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/twilio`;
          const recordingStatusCallbackUrl = `${env.backendPublicUrl}/api/calls/webhook/recording`;

          const dialerSettings = await getCredentials(call.userId, 'dialer');
          const recordingEnabled = dialerSettings?.recordCallsEnabled === 'true';

          try {
            const { agentCallSid } = await provider.bridgeToAgent({
              providerCallId: call.providerCallId,
              from: callerNumber.phoneNumber,
              agentPhoneNumber: toE164BR(agent.phoneNumber) || agent.phoneNumber,
              conferenceRoomName: conferenceRoom,
              statusCallbackUrl,
              recordingEnabled,
              recordingStatusCallbackUrl
            });

            updateData.agentProviderCallId = agentCallSid;
            updateData.conferenceRoom = conferenceRoom;
          } catch (bridgeError) {
            console.error(`❌ Não foi possível ligar para o vendedor ${agent.name}: ${bridgeError.message}`);
            await prisma.callEvent.create({
              data: { callId: call.id, eventType: 'vendedor_falha_repasse', rawPayload: { error: bridgeError.message } }
            }).catch(() => {});
            await prisma.call.update({ where: { id: call.id }, data: updateData });
            await handleAgentMissed({ ...call, ...updateData }, bridgeError.message);
            res.set('Content-Type', 'text/xml');
            return res.status(200).send('<Response></Response>');
          }
        }
      }
    }

    if (CallStatus === 'completed') {
      await prisma.call.update({ where: { id: call.id }, data: updateData });
      const updatedCall = await prisma.call.findUnique({ where: { id: call.id } });
      await finalizeCall(updatedCall);
    } else {
      await prisma.call.update({ where: { id: call.id }, data: updateData });
    }

    if (['busy', 'failed', 'no-answer'].includes(CallStatus)) {
      // Lead não atendeu: volta para a fila (até MAX_QUEUE_ATTEMPTS vezes, com intervalo) e o vendedor é liberado.
      const item = await prisma.callQueueItem.findFirst({ where: { leadId: call.leadId, status: 'discando' } });
      if (item) {
        const again = item.attempts < MAX_QUEUE_ATTEMPTS && CallStatus !== 'failed';
        await prisma.callQueueItem.update({
          where: { id: item.id },
          data: again
            ? { status: 'pendente', scheduledAt: new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000), lastError: `Não atendeu (${CallStatus})` }
            : { status: 'falhou', lastError: CallStatus === 'failed' ? 'A ligação falhou' : `Não atendeu em ${item.attempts} tentativas` }
        });
      }

      await releaseAgent(call.agentId);

      const io = global.socketIoInstance;
      if (io) {
        io.to(`user:${call.userId}`).emit('call:ended', { callId: call.id, status: mappedStatus });
      }
    }

    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  } catch (error) {
    next(error);
  }
};

/**
 * Recebe o aviso da Twilio quando a gravação da conferência fica pronta.
 * O "FriendlyName" da conferência é o mesmo conferenceRoom que usamos
 * (padrão "call_<id>"), então extraímos o id da nossa Call diretamente dele.
 */
exports.handleRecordingStatusWebhook = async (req, res, next) => {
  try {
    const { RecordingUrl, RecordingSid, RecordingStatus, FriendlyName } = req.body;

    if (RecordingStatus !== 'completed' || !FriendlyName || !FriendlyName.startsWith('call_')) {
      res.set('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    const callId = FriendlyName.replace('call_', '');

    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (call) {
      await prisma.call.update({
        where: { id: call.id },
        data: { recordingUrl: RecordingUrl, recordingSid: RecordingSid }
      });

      const io = global.socketIoInstance;
      if (io) {
        io.to(`user:${call.userId}`).emit('call:recording_ready', { callId: call.id });
      }
    }

    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  } catch (error) {
    next(error);
  }
};

async function finalizeCall(call) {
  const endedAt = new Date();
  const durationSeconds = call.answeredAt
    ? Math.round((endedAt.getTime() - new Date(call.answeredAt).getTime()) / 1000)
    : 0;

  await prisma.call.update({
    where: { id: call.id },
    data: { status: 'encerrada', endedAt, durationSeconds }
  });

  await prisma.callQueueItem.updateMany({
    where: { leadId: call.leadId, status: 'discando' },
    data: { status: 'concluido' }
  });

  // Libera o vendedor: o motor automático (jobs/dialerAutoJob.js) já enxerga que ele ficou livre e segue discando.
  await releaseAgent(call.agentId);

  // Se a perna do vendedor ainda estiver tocando (o lead desligou antes), encerra-a.
  if (call.agentProviderCallId) {
    try {
      const provider = await getActiveTelephonyProvider(call.userId);
      await provider.hangupCall({ providerCallId: call.agentProviderCallId });
    } catch (_) {
      /* a perna já tinha terminado */
    }
  }

  const io = global.socketIoInstance;
  if (io) {
    io.to(`user:${call.userId}`).emit('call:ended', {
      callId: call.id,
      status: 'encerrada',
      durationSeconds
    });
  }
}

/**
 * O vendedor escolhido não atendeu (ou não foi possível ligar para ele) enquanto o lead já estava na linha:
 * desliga o lead, devolve-o ao início da fila e pausa o vendedor para o discador não insistir nele.
 */
async function handleAgentMissed(call, reason) {
  const provider = await getActiveTelephonyProvider(call.userId).catch(() => null);
  if (provider && call.providerCallId) await provider.hangupCall({ providerCallId: call.providerCallId }).catch(() => {});

  await prisma.call.update({ where: { id: call.id }, data: { status: 'encerrada', endedAt: new Date(), durationSeconds: 0 } }).catch(() => {});
  await prisma.callQueueItem.updateMany({
    where: { leadId: call.leadId, status: 'discando' },
    data: { status: 'pendente', scheduledAt: new Date(), lastError: reason || 'O vendedor não atendeu o repasse' }
  });

  if (call.agentId) {
    await prisma.agent.update({ where: { id: call.agentId }, data: { status: 'disponivel', isPaused: true, pausedAt: new Date() } });
  }

  const io = global.socketIoInstance;
  if (io) {
    io.to(`user:${call.userId}`).emit('call:ended', { callId: call.id, status: 'encerrada' });
    io.to(`user:${call.userId}`).emit('dialer:agent_auto_paused', { agentId: call.agentId });
  }
}