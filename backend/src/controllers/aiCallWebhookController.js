// backend/src/controllers/aiCallWebhookController.js
//
// Endpoints PÚBLICOS chamados pela Twilio durante uma ligação do agente de IA:
//  - status:      "tocando / atendeu / terminou"
//  - turn:        o que o lead falou — aqui a IA decide a próxima fala
//  - dial-result: resultado da transferência para o vendedor
//  - recording:   gravação pronta (se ativada no agente)
const prisma = require('../config/db');
const { processTurn, handleDialResult, handleAnswerCall, finalizeAiCall, TERMINAL_STATUSES } = require('../services/ai/voice/aiCallService');
const { speechify, resolveFile } = require('../services/ai/voice/geminiTtsService');
const { convertResponse, normalizeIncoming } = require('../services/telephony/markupAdapters');

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

// Cada operadora fala um "idioma": Twilio = TwiML (como sempre), Telnyx = TeXML, Jambonz = JSON.
// O endereço de retorno traz ?dialect=... para sabermos como responder e como ler o que chegou.
function dialectOf(req) {
  const d = String(req.query.dialect || '');
  return d === 'texml' || d === 'jambonz' ? d : 'twiml';
}

async function sendMarkup(req, res, xml) {
  // Voz do Gemini: troca os <Say> marcados por <Play>. Falha aqui nunca derruba a ligação.
  let markup = xml;
  try {
    markup = await speechify(xml);
  } catch (error) {
    console.warn('⚠️ speechify falhou:', error.message);
  }
  const { type, body } = convertResponse(markup, dialectOf(req), { sttEngine: process.env.TELNYX_STT_ENGINE || 'deepgram' });
  res.set('Content-Type', type);
  res.status(200).send(body);
}

exports.handleStatus = async (req, res) => {
  try {
    const { callId } = req.query;
    const { CallSid, CallStatus } = normalizeIncoming(req.body, dialectOf(req));

    const call = callId ? await prisma.call.findUnique({ where: { id: String(callId) } }) : null;
    if (!call) return await sendMarkup(req, res, EMPTY_TWIML);

    await prisma.callEvent.create({ data: { callId: call.id, eventType: CallStatus || 'desconhecido', rawPayload: req.body } });

    const mapped = STATUS_MAP[CallStatus];
    if (!mapped) return await sendMarkup(req, res, EMPTY_TWIML);

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

    await sendMarkup(req, res, EMPTY_TWIML);
  } catch (error) {
    console.error('Erro no webhook de status do agente IA:', error.message);
    await sendMarkup(req, res, EMPTY_TWIML);
  }
};

/** Abertura da ligação (Telnyx / Jambonz consultam este endereço quando o cliente atende). */
exports.handleAnswer = async (req, res) => {
  try {
    const { callId } = req.query;
    if (!callId) return await sendMarkup(req, res, BYE_TWIML);
    await sendMarkup(req, res, await handleAnswerCall(String(callId)));
  } catch (error) {
    console.error('Erro no webhook de atendimento do agente IA:', error.message);
    await sendMarkup(req, res, BYE_TWIML);
  }
};

/** Entrega o áudio gerado pela voz do Gemini (a operadora baixa e toca na ligação). */
exports.serveTts = (req, res) => {
  const file = resolveFile(req.params.name);
  if (!file) return res.status(404).end();
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(file);
};

exports.handleTurn = async (req, res) => {
  try {
    const { callId } = req.query;
    const { CallSid, SpeechResult, Confidence } = normalizeIncoming(req.body, dialectOf(req));
    if (!callId) return await sendMarkup(req, res, BYE_TWIML);

    const call = await prisma.call.findUnique({ where: { id: String(callId) }, select: { providerCallId: true } });
    if (!call) return await sendMarkup(req, res, BYE_TWIML);
    // A chamada precisa vir da mesma ligação que criamos (conferência só com a Twilio; nas outras
    // operadoras o identificador pode mudar de formato — o callId já é um código único e secreto).
    if (dialectOf(req) === 'twiml' && call.providerCallId && CallSid && call.providerCallId !== CallSid) {
      return await sendMarkup(req, res, '<Response><Hangup/></Response>');
    }

    const twiml = await processTurn({ callId: String(callId), speech: SpeechResult, confidence: Confidence });
    await sendMarkup(req, res, twiml);
  } catch (error) {
    console.error('Erro no webhook de conversa do agente IA:', error.message);
    await sendMarkup(req, res, BYE_TWIML);
  }
};

exports.handleDialResult = async (req, res) => {
  try {
    const { callId } = req.query;
    if (!callId) return await sendMarkup(req, res, '<Response><Hangup/></Response>');
    await sendMarkup(req, res, await handleDialResult({ callId: String(callId), dialStatus: normalizeIncoming(req.body, dialectOf(req)).DialCallStatus }));
  } catch (error) {
    console.error('Erro no webhook de transferência do agente IA:', error.message);
    await sendMarkup(req, res, '<Response><Hangup/></Response>');
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
  await sendMarkup(req, res, EMPTY_TWIML);
};
