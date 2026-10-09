// backend/src/controllers/aiCallWebhookController.js
//
// Endpoints PÚBLICOS chamados pela Twilio durante uma ligação do agente de IA:
//  - status:      "tocando / atendeu / terminou"
//  - turn:        o que o lead falou — aqui a IA decide a próxima fala
//  - dial-result: resultado da transferência para o vendedor
//  - recording:   gravação pronta (se ativada no agente)
const prisma = require('../config/db');
const { processTurn, handleDialResult, finalizeAiCall, TERMINAL_STATUSES } = require('../services/ai/voice/aiCallService');

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

const EMPTY_TWIML = '<Response></Response>';
const BYE_TWIML = '<Response><Say language="pt-BR">Obrigado pela atenção, até logo.</Say><Hangup/></Response>';

function sendTwiml(res, xml) {
  res.set('Content-Type', 'text/xml');
  res.status(200).send(xml);
}

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

    if (!alreadyTerminal && TERMINAL_STATUSES.includes(mapped)) {
      // Em segundo plano: aplica o resultado no CRM e atualiza os contadores.
      finalizeAiCall(call.id)
        .then(() => {
          const io = global.socketIoInstance;
          if (io) io.to(`user:${call.userId}`).emit('aicall:progress', { campaignId: call.aiCallCampaignId });
        })
        .catch((error) => console.error('Erro ao finalizar ligação do agente IA:', error.message));
    }

    sendTwiml(res, EMPTY_TWIML);
  } catch (error) {
    console.error('Erro no webhook de status do agente IA:', error.message);
    sendTwiml(res, EMPTY_TWIML);
  }
};

exports.handleTurn = async (req, res) => {
  try {
    const { callId } = req.query;
    const { CallSid, SpeechResult, Confidence } = req.body;
    if (!callId) return sendTwiml(res, BYE_TWIML);

    const call = await prisma.call.findUnique({ where: { id: String(callId) }, select: { providerCallId: true } });
    if (!call) return sendTwiml(res, BYE_TWIML);
    // A chamada precisa vir da mesma ligação que criamos.
    if (call.providerCallId && CallSid && call.providerCallId !== CallSid) {
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }

    const twiml = await processTurn({ callId: String(callId), speech: SpeechResult, confidence: Confidence });
    sendTwiml(res, twiml);
  } catch (error) {
    console.error('Erro no webhook de conversa do agente IA:', error.message);
    sendTwiml(res, BYE_TWIML);
  }
};

exports.handleDialResult = async (req, res) => {
  try {
    const { callId } = req.query;
    if (!callId) return sendTwiml(res, '<Response><Hangup/></Response>');
    sendTwiml(res, await handleDialResult({ callId: String(callId), dialStatus: req.body.DialCallStatus }));
  } catch (error) {
    console.error('Erro no webhook de transferência do agente IA:', error.message);
    sendTwiml(res, '<Response><Hangup/></Response>');
  }
};

exports.handleRecording = async (req, res) => {
  try {
    const { callId } = req.query;
    const { RecordingUrl, RecordingSid, RecordingStatus } = req.body;
    if (callId && RecordingStatus === 'completed' && RecordingUrl) {
      await prisma.call.updateMany({ where: { id: String(callId) }, data: { recordingUrl: RecordingUrl, recordingSid: RecordingSid } });
    }
  } catch (error) {
    console.error('Erro no webhook de gravação do agente IA:', error.message);
  }
  sendTwiml(res, EMPTY_TWIML);
};
