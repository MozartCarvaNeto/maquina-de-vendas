// backend/src/controllers/callsWebhookController.js
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { getCredentials } = require('../services/integrationFactory');
const { startNextCall } = require('../services/dialerQueueService');

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

          const { agentCallSid } = await provider.bridgeToAgent({
            providerCallId: call.providerCallId,
            from: callerNumber.phoneNumber,
            agentPhoneNumber: agent.phoneNumber,
            conferenceRoomName: conferenceRoom,
            statusCallbackUrl,
            recordingEnabled,
            recordingStatusCallbackUrl
          });

          updateData.agentProviderCallId = agentCallSid;
          updateData.conferenceRoom = conferenceRoom;
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
      await prisma.callQueueItem.updateMany({
        where: { leadId: call.leadId, status: 'discando' },
        data: { status: 'falhou' }
      });

      if (call.agentId) {
        await prisma.agent.update({ where: { id: call.agentId }, data: { status: 'disponivel' } });
      }

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

  if (call.agentId) {
    await prisma.agent.update({ where: { id: call.agentId }, data: { status: 'disponivel' } });
  }

  const io = global.socketIoInstance;
  if (io) {
    io.to(`user:${call.userId}`).emit('call:ended', {
      callId: call.id,
      status: 'encerrada',
      durationSeconds
    });
  }

  const dialerSettings = await getCredentials(call.userId, 'dialer');
  if (dialerSettings?.autoDialEnabled === 'true') {
    setTimeout(() => {
      startNextCall(call.userId).catch((err) =>
        console.error('Erro ao iniciar próxima ligação automática:', err.message)
      );
    }, 5000);
  }
}