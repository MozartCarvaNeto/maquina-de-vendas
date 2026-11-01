// backend/src/services/whatsapp/metaCallingService.js
//
// Chamadas de voz do WhatsApp pela API Oficial da Meta (Cloud API "Calling").
// O áudio NÃO passa por este servidor: o navegador do vendedor fala direto com a Meta (WebRTC).
// Aqui só fica a "sinalização": trocar o SDP (a proposta de conexão) e acompanhar o estado da chamada.
//
// Fluxo de chamada RECEBIDA:  webhook "calls" (connect + SDP offer) -> avisa o navegador (socket)
//   -> navegador cria a resposta (SDP answer) -> POST /calls pre_accept + accept -> áudio flui.
// Fluxo de chamada FEITA:     navegador cria o SDP offer -> POST /calls connect -> webhook traz o SDP answer
//   -> navegador aplica a resposta -> áudio flui.
//
// Requisitos na Meta: número com "Calling" ativado (limite de mensagens >= 2000), campo "calls" assinado
// no webhook e, para ligar PRIMEIRO, permissão do contato (call permission).
const prisma = require('../../config/db');
const metaCloudApiService = require('./metaCloudApiService');
const whatsappDispatcher = require('./whatsappDispatcher');

const CALL_TTL_MS = 3 * 60 * 60 * 1000;
/** callId -> { userId, connectionId, leadId, direction, status, startedAt, answeredAt } */
const calls = new Map();

function remember(callId, data) {
  const existing = calls.get(callId);
  if (existing) Object.assign(existing, data, { updatedAt: Date.now() }); // mesmo objeto: mantém a marca "recorded"
  else calls.set(callId, { ...data, updatedAt: Date.now() });
  if (calls.size > 500) {
    const limit = Date.now() - CALL_TTL_MS;
    for (const [id, c] of calls) if (c.updatedAt < limit) calls.delete(id);
  }
  return calls.get(callId);
}

function io() {
  return global.socketIoInstance || null;
}

function emit(userId, event, payload) {
  const socket = io();
  if (socket) socket.to(`user:${userId}`).emit(event, payload);
}

function callError(error) {
  const code = error?.graphPayload?.error?.code;
  const sub = error?.graphPayload?.error?.error_subcode;
  const message = error?.graphPayload?.error?.message || error.message;
  const map = {
    138006: 'Este contato ainda não autorizou receber ligações. Envie um pedido de permissão de chamada e aguarde ele aceitar.',
    138010: 'A permissão de chamada deste contato expirou. Envie um novo pedido de permissão.',
    138011: 'Limite de pedidos de permissão atingido para este contato (máx. 2 a cada 7 dias).',
    138012: 'Limite de chamadas para este contato atingido (máx. 5 a cada 24 h). Tente mais tarde.',
    138014: 'A Meta recusou a conexão de áudio (SDP inválido). Atualize a página e tente de novo.'
  };
  const text = map[code] || map[sub] || `A Meta recusou a operação de chamada: ${message}`;
  const err = new Error(text);
  err.status = 502;
  return err;
}

async function loadConnection(userId, connectionId) {
  const own = await prisma.whatsappConnection.findFirst({ where: { id: connectionId, userId, provider: 'cloud_api' } });
  if (!own) {
    const err = new Error('Chamadas de WhatsApp só funcionam em conexões da API Oficial da Meta (Cloud API).');
    err.status = 400;
    throw err;
  }
  const connection = await whatsappDispatcher.loadConnectionForSending(connectionId);
  if (!connection?.accessToken) {
    const err = new Error('Conexão sem token de acesso.');
    err.status = 400;
    throw err;
  }
  return connection;
}

async function postCalls(connection, body) {
  try {
    return await metaCloudApiService.graphRequest(`${connection.phoneNumberId}/calls`, {
      method: 'POST',
      token: connection.accessToken,
      body: { messaging_product: 'whatsapp', ...body }
    });
  } catch (error) {
    throw callError(error);
  }
}

// ---------------------------------------------------------------- ações pedidas pelo navegador

/** Liga o recurso "Calling" no número (precisa de limite de mensagens >= 2000 na Meta). */
async function enableCalling(userId, connectionId, { enabled = true } = {}) {
  const connection = await loadConnection(userId, connectionId);
  try {
    return await metaCloudApiService.graphRequest(`${connection.phoneNumberId}/settings`, {
      method: 'POST',
      token: connection.accessToken,
      body: { calling: { status: enabled ? 'ENABLED' : 'DISABLED', call_icon_visibility: 'DEFAULT' } }
    });
  } catch (error) {
    throw callError(error);
  }
}

async function getCallingSettings(userId, connectionId) {
  const connection = await loadConnection(userId, connectionId);
  const data = await metaCloudApiService.graphRequest(`${connection.phoneNumberId}/settings`, { token: connection.accessToken });
  return data.calling || data;
}

/** Vendedor liga para o lead: recebe o SDP offer gerado no navegador e devolve o callId. */
async function startOutgoingCall({ userId, connectionId, leadId, sdpOffer }) {
  if (!sdpOffer) {
    const err = new Error('Faltou a proposta de áudio (SDP) do navegador.');
    err.status = 400;
    throw err;
  }
  const connection = await loadConnection(userId, connectionId);
  const lead = await prisma.lead.findFirst({ where: { id: leadId, userId } });
  if (!lead?.phone) {
    const err = new Error('Lead sem telefone.');
    err.status = 400;
    throw err;
  }
  const to = metaCloudApiService.normalizePhoneDigits(lead.phone);
  const data = await postCalls(connection, {
    to,
    action: 'connect',
    session: { sdp_type: 'offer', sdp: sdpOffer }
  });
  const callId = data.calls?.[0]?.id;
  if (!callId) {
    const err = new Error('A Meta não devolveu o identificador da chamada.');
    err.status = 502;
    throw err;
  }
  remember(callId, { userId, connectionId, leadId: lead.id, direction: 'saida', status: 'chamando', startedAt: Date.now() });
  return { callId, lead: { id: lead.id, name: lead.name, phone: lead.phone } };
}

function ownedCall(userId, callId) {
  const call = calls.get(callId);
  if (!call || call.userId !== userId) {
    const err = new Error('Chamada não encontrada (ela pode já ter terminado).');
    err.status = 404;
    throw err;
  }
  return call;
}

/** Vendedor atende: recebe o SDP answer gerado no navegador. Meta pede pre_accept e depois accept com o MESMO SDP. */
async function acceptIncomingCall({ userId, callId, sdpAnswer }) {
  const call = ownedCall(userId, callId);
  const connection = await loadConnection(userId, call.connectionId);
  const session = { sdp_type: 'answer', sdp: sdpAnswer };
  await postCalls(connection, { call_id: callId, action: 'pre_accept', session });
  await postCalls(connection, { call_id: callId, action: 'accept', session });
  remember(callId, { status: 'em_andamento', answeredAt: Date.now() });
  return { ok: true };
}

async function rejectIncomingCall({ userId, callId }) {
  const call = ownedCall(userId, callId);
  const connection = await loadConnection(userId, call.connectionId);
  await postCalls(connection, { call_id: callId, action: 'reject' });
  remember(callId, { status: 'recusada', rejectedByUs: true });
  await recordCallMessage(call, { outcome: 'recusada' });
  return { ok: true };
}

async function terminateCall({ userId, callId }) {
  const call = ownedCall(userId, callId);
  const connection = await loadConnection(userId, call.connectionId);
  await postCalls(connection, { call_id: callId, action: 'terminate' });
  remember(callId, { terminatedByUs: true });
  return { ok: true };
}

/** Pede ao contato permissão para ligar (mensagem interativa). Necessário antes de ligar para quem não ligou para você. */
async function requestCallPermission({ userId, connectionId, leadId }) {
  const connection = await loadConnection(userId, connectionId);
  const lead = await prisma.lead.findFirst({ where: { id: leadId, userId } });
  if (!lead?.phone) {
    const err = new Error('Lead sem telefone.');
    err.status = 400;
    throw err;
  }
  try {
    await metaCloudApiService.graphRequest(`${connection.phoneNumberId}/messages`, {
      method: 'POST',
      token: connection.accessToken,
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: metaCloudApiService.normalizePhoneDigits(lead.phone),
        type: 'interactive',
        interactive: {
          type: 'call_permission_request',
          action: { name: 'call_permission_request' },
          body: { text: 'Podemos ligar para você pelo WhatsApp para continuar o atendimento?' }
        }
      }
    });
  } catch (error) {
    throw callError(error);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- webhook da Meta

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}min ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

async function findOrCreateLead(userId, phone, name) {
  if (!phone) return null;
  let lead = await prisma.lead.findFirst({ where: { userId, phone: { contains: phone } } });
  if (!lead) {
    lead = await prisma.lead.create({
      data: { userId, name: name || phone, phone, consentSource: 'whatsapp_organico', status: 'novo' }
    });
  }
  return lead;
}

/** Registra no chat o resultado da chamada (aparece como mensagem na conversa). */
async function recordCallMessage(call, { outcome, duration }) {
  if (!call?.leadId || call.recorded) return;
  call.recorded = true;
  const incoming = call.direction === 'entrada';
  let body;
  if (duration > 0) body = `📞 Chamada de voz ${incoming ? 'recebida' : 'realizada'} pelo WhatsApp — duração ${formatDuration(duration)}`;
  else if (outcome === 'recusada') body = `📞 Chamada de voz ${incoming ? 'recusada por você' : 'recusada pelo contato'}`;
  else body = incoming ? '📞 Chamada de voz perdida pelo WhatsApp' : '📞 Chamada de voz não atendida pelo contato';
  try {
    const message = await prisma.message.create({
      data: { leadId: call.leadId, direction: incoming ? 'entrada' : 'saida', channel: 'whatsapp', body }
    });
    emit(call.userId, 'whatsapp:message', { leadId: call.leadId, message });
  } catch (err) {
    console.warn(`⚠️ Não consegui registrar a chamada no chat: ${err.message}`);
  }
}

/** Trata o campo "calls" do webhook. `value` = change.value da Meta; `connection` = linha do WhatsappConnection. */
async function handleCallsWebhook(connection, value) {
  const userId = connection.userId;

  for (const call of value.calls || []) {
    const callId = call.id;
    const event = String(call.event || '').toLowerCase();

    if (event === 'connect') {
      if (call.direction === 'USER_INITIATED') {
        const phone = String(call.from || value.contacts?.[0]?.wa_id || '').replace(/\D/g, '');
        const contactName = value.contacts?.[0]?.profile?.name;
        const lead = await findOrCreateLead(userId, phone, contactName);
        remember(callId, {
          userId,
          connectionId: connection.id,
          leadId: lead?.id || null,
          direction: 'entrada',
          status: 'tocando',
          startedAt: Date.now()
        });
        emit(userId, 'whatsapp:call:incoming', {
          callId,
          connectionId: connection.id,
          leadId: lead?.id || null,
          name: lead?.name || contactName || phone,
          phone,
          sdpOffer: call.session?.sdp || null
        });
      } else if (call.session?.sdp_type === 'answer') {
        remember(callId, { status: 'em_andamento', answeredAt: Date.now() });
        emit(userId, 'whatsapp:call:answer', { callId, sdpAnswer: call.session.sdp });
      }
    } else if (event === 'terminate') {
      const known = remember(callId, { status: 'encerrada' });
      const duration = Number(call.duration) || 0;
      emit(userId, 'whatsapp:call:ended', {
        callId,
        status: call.status || null,
        duration,
        error: call.errors?.[0]?.message || null
      });
      if (known.userId) await recordCallMessage(known, { outcome: call.status === 'FAILED' ? 'falhou' : undefined, duration });
    }
  }

  for (const status of value.statuses || []) {
    if (status.type !== 'call') continue;
    emit(userId, 'whatsapp:call:status', { callId: status.id, status: String(status.status || '').toUpperCase() });
  }

  // Resposta do contato ao pedido de permissão de chamada.
  for (const message of value.messages || []) {
    const reply = message.interactive?.call_permission_reply;
    if (message.type === 'interactive' && reply) {
      emit(userId, 'whatsapp:call:permission', {
        phone: message.from,
        granted: reply.response === 'accept',
        permanent: Boolean(reply.is_permanent)
      });
    }
  }
}

module.exports = {
  enableCalling,
  getCallingSettings,
  startOutgoingCall,
  acceptIncomingCall,
  rejectIncomingCall,
  terminateCall,
  requestCallPermission,
  handleCallsWebhook,
  _calls: calls
};
