// backend/src/controllers/roboCallWebhookController.js
//
// Endpoints PÚBLICOS chamados pela Twilio durante uma ligação robô:
//  - status:    avisos de "tocando / atendeu / terminou"
//  - gather:    o que o lead respondeu (tecla ou voz) — aqui decidimos o rumo da ligação
//  - recording: aviso de que a gravação da ligação ficou pronta
const prisma = require('../config/db');
const {
  TERMINAL_STATUSES,
  classifyResponse,
  buildInterestedTwiml,
  buildNotInterestedTwiml,
  handleQualifiedLead
} = require('../services/roboCallService');

const STATUS_MAP = {
  queued: 'iniciando',
  initiated: 'iniciando',
  ringing: 'tocando',
  'in-progress': 'atendida',
  answered: 'atendida',
  completed: 'encerrada',
  busy: 'ocupado',
  failed: 'falhou',
  'no-answer': 'sem_resposta',
  canceled: 'falhou'
};

function sendTwiml(res, xml) {
  res.set('Content-Type', 'text/xml');
  res.status(200).send(xml);
}

const EMPTY_TWIML = '<Response></Response>';

exports.handleStatus = async (req, res) => {
  try {
    const { callId } = req.query;
    const { CallSid, CallStatus } = req.body;

    const call = callId ? await prisma.call.findUnique({ where: { id: String(callId) } }) : null;
    if (!call) return sendTwiml(res, EMPTY_TWIML);

    await prisma.callEvent.create({ data: { callId: call.id, eventType: CallStatus || 'desconhecido', rawPayload: req.body } });

    const mapped = STATUS_MAP[CallStatus];
    if (!mapped) return sendTwiml(res, EMPTY_TWIML);

    const alreadyTerminal = TERMINAL_STATUSES.includes(call.status);
    const data = {};
    if (!call.providerCallId && CallSid) data.providerCallId = CallSid;

    if (!alreadyTerminal) {
      data.status = mapped;
      if (mapped === 'atendida' && !call.answeredAt) data.answeredAt = new Date();

      if (TERMINAL_STATUSES.includes(mapped)) {
        const endedAt = new Date();
        data.endedAt = endedAt;
        data.durationSeconds = call.answeredAt
          ? Math.round((endedAt.getTime() - new Date(call.answeredAt).getTime()) / 1000)
          : 0;
      }
    }

    await prisma.call.update({ where: { id: call.id }, data });

    if (!alreadyTerminal && TERMINAL_STATUSES.includes(mapped) && call.roboCallCampaignId) {
      const neverAnswered = ['ocupado', 'falhou', 'sem_resposta'].includes(mapped) || !call.answeredAt;
      await prisma.roboCallCampaign.update({
        where: { id: call.roboCallCampaignId },
        data: {
          calledCount: { increment: 1 },
          ...(neverAnswered ? { noAnswerCount: { increment: 1 } } : {})
        }
      });
      const io = global.socketIoInstance;
      if (io) io.to(`user:${call.userId}`).emit('robocall:progress', { campaignId: call.roboCallCampaignId });
    }

    sendTwiml(res, EMPTY_TWIML);
  } catch (error) {
    console.error('Erro no webhook de status da ligação robô:', error.message);
    sendTwiml(res, EMPTY_TWIML);
  }
};

exports.handleGather = async (req, res) => {
  try {
    const { callId } = req.query;
    const { CallSid, Digits, SpeechResult, Confidence } = req.body;

    const call = callId
      ? await prisma.call.findUnique({ where: { id: String(callId) }, include: { roboCallCampaign: true, lead: true } })
      : null;

    if (!call || !call.roboCallCampaign) {
      return sendTwiml(res, '<Response><Say language="pt-BR">Obrigado, até logo.</Say><Hangup/></Response>');
    }
    // A chamada do webhook precisa vir da mesma ligação que criamos.
    if (call.providerCallId && CallSid && call.providerCallId !== CallSid) {
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }

    const campaign = call.roboCallCampaign;

    // A Twilio pode repetir a chamada do webhook — não processa duas vezes.
    if (call.qualified !== null && call.qualified !== undefined) {
      return sendTwiml(res, call.qualified ? buildInterestedTwiml(campaign) : buildNotInterestedTwiml(campaign));
    }

    const { decision, optOut } = classifyResponse(
      { digits: Digits, speech: SpeechResult, confidence: Confidence },
      campaign
    );
    const qualified = decision === 'interessado';

    await prisma.call.update({
      where: { id: call.id },
      data: {
        digitsPressed: Digits ? String(Digits) : null,
        speechResult: SpeechResult ? String(SpeechResult).slice(0, 500) : null,
        qualified
      }
    });
    await prisma.callEvent.create({
      data: { callId: call.id, eventType: `resposta_${decision}`, rawPayload: req.body }
    });

    await prisma.roboCallCampaign.update({
      where: { id: campaign.id },
      data: qualified ? { interestedCount: { increment: 1 } } : { notInterestedCount: { increment: 1 } }
    });

    if (optOut) {
      await prisma.lead.update({ where: { id: call.leadId }, data: { optOut: true } });
    }

    if (qualified) {
      await handleQualifiedLead(campaign, call, call.lead);
      return sendTwiml(res, buildInterestedTwiml(campaign));
    }
    return sendTwiml(res, buildNotInterestedTwiml(campaign));
  } catch (error) {
    console.error('Erro no webhook de resposta da ligação robô:', error.message);
    sendTwiml(res, '<Response><Say language="pt-BR">Obrigado pela atenção, até logo.</Say><Hangup/></Response>');
  }
};

exports.handleRecording = async (req, res) => {
  try {
    const { callId } = req.query;
    const { RecordingUrl, RecordingSid, RecordingStatus } = req.body;
    if (callId && RecordingStatus === 'completed' && RecordingUrl) {
      await prisma.call.updateMany({
        where: { id: String(callId) },
        data: { recordingUrl: RecordingUrl, recordingSid: RecordingSid }
      });
    }
  } catch (error) {
    console.error('Erro no webhook de gravação da ligação robô:', error.message);
  }
  sendTwiml(res, EMPTY_TWIML);
};
