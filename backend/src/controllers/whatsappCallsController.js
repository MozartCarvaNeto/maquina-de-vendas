// backend/src/controllers/whatsappCallsController.js
// Rotas do "telefone no navegador" (chamadas de WhatsApp pela API Oficial da Meta).
const prisma = require('../config/db');
const env = require('../config/env');
const metaCallingService = require('../services/whatsapp/metaCallingService');

const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function iceServers() {
  if (!env.webrtcIceServers) return DEFAULT_ICE;
  try {
    const parsed = JSON.parse(env.webrtcIceServers);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_ICE;
  } catch {
    console.warn('⚠️ WEBRTC_ICE_SERVERS inválido (precisa ser JSON). Usando STUN padrão.');
    return DEFAULT_ICE;
  }
}

const wrap = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    next(error);
  }
};

/** Dados para o telefone abrir: servidores de rede e as conexões da API Oficial (as únicas que fazem chamada). */
exports.config = wrap(async (req) => {
  const connections = await prisma.whatsappConnection.findMany({
    where: { userId: req.userId, provider: 'cloud_api', status: 'conectado' },
    select: { id: true, instanceName: true, phone: true }
  });
  return { iceServers: iceServers(), connections };
});

exports.settings = wrap((req) => metaCallingService.getCallingSettings(req.userId, req.params.connectionId));
exports.enable = wrap((req) =>
  metaCallingService.enableCalling(req.userId, req.params.connectionId, { enabled: req.body?.enabled !== false })
);
exports.outgoing = wrap((req) =>
  metaCallingService.startOutgoingCall({
    userId: req.userId,
    connectionId: req.body.connectionId,
    leadId: req.body.leadId,
    sdpOffer: req.body.sdp
  })
);
exports.accept = wrap((req) =>
  metaCallingService.acceptIncomingCall({ userId: req.userId, callId: req.params.callId, sdpAnswer: req.body.sdp })
);
exports.reject = wrap((req) => metaCallingService.rejectIncomingCall({ userId: req.userId, callId: req.params.callId }));
exports.terminate = wrap((req) => metaCallingService.terminateCall({ userId: req.userId, callId: req.params.callId }));
exports.permission = wrap((req) =>
  metaCallingService.requestCallPermission({ userId: req.userId, connectionId: req.body.connectionId, leadId: req.body.leadId })
);
