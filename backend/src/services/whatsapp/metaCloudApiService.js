// backend/src/services/whatsapp/metaCloudApiService.js
//
// Conexão de WhatsApp pela API Oficial da Meta (WhatsApp Business Platform),
// como alternativa ao QR Code. Não existe "sessão" nem Chromium aqui — é só
// uma chamada HTTP autenticada com o token de acesso de cada número.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const prisma = require('../../config/db');
const { encrypt, decrypt } = require('../crypto/settingsCrypto');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function normalizePhoneDigits(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

function friendlyGraphError(error, status) {
  const metaMessage = error?.error?.message;
  const metaCode = error?.error?.code;
  if (metaCode === 190) return 'O token de acesso da Meta expirou ou é inválido. Gere um novo token e atualize a conexão.';
  if (metaCode === 100 && /phone number/i.test(metaMessage || '')) return 'O "Phone Number ID" cadastrado não existe ou não pertence a este token.';
  if (metaCode === 131047) return 'A janela de 24h de atendimento com este contato expirou. É preciso usar um modelo (template) aprovado pela Meta para reabrir a conversa.';
  if (metaCode === 131026) return 'Este número não tem WhatsApp ou não pode receber mensagens no momento.';
  return metaMessage ? `Meta recusou o envio: ${metaMessage}` : `Erro ao falar com a API da Meta (HTTP ${status}).`;
}

async function graphRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${GRAPH_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(friendlyGraphError(data, response.status));
    err.status = 502;
    err.graphPayload = data;
    throw err;
  }
  return data;
}

/** Confere se o Phone Number ID + token realmente se enxergam, e devolve o número de telefone de verdade cadastrado na Meta. */
async function validateConnection({ phoneNumberId, accessToken }) {
  const data = await graphRequest(`${phoneNumberId}?fields=verified_name,display_phone_number,code_verification_status`, {
    token: accessToken
  });
  return {
    displayPhoneNumber: data.display_phone_number,
    verifiedName: data.verified_name,
    codeVerificationStatus: data.code_verification_status
  };
}

/** Envia o arquivo para a Meta e devolve o id da mídia (funciona com arquivos privados). */
async function uploadMedia(connection, filePath, mimeType, fileName) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), fileName || path.basename(filePath));

  const response = await fetch(`${GRAPH_BASE}/${connection.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.accessToken}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const err = new Error(friendlyGraphError(data, response.status));
    err.status = 502;
    throw err;
  }
  return data.id;
}

/** Baixa uma mídia recebida (a Meta entrega só o id; a URL exige o token). */
async function downloadMedia(connection, mediaId) {
  const info = await graphRequest(mediaId, { token: connection.accessToken });
  if (!info.url) throw new Error('A Meta não devolveu a URL da mídia.');
  const response = await fetch(info.url, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
  if (!response.ok) throw new Error(`Falha ao baixar a mídia da Meta (HTTP ${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType: info.mime_type || response.headers.get('content-type') || 'application/octet-stream' };
}

/**
 * Envia foto/vídeo/áudio/documento a partir de um arquivo local: sobe o
 * arquivo para a Meta e manda pelo id. `opts` = { mimeType, fileName }.
 */
async function sendMediaFile(connection, toPhone, text, filePath, opts = {}) {
  const to = normalizePhoneDigits(toPhone);
  if (!to) {
    const err = new Error('Telefone do lead inválido ou vazio.');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(filePath)) {
    const err = new Error('Arquivo não encontrado no servidor.');
    err.status = 500;
    throw err;
  }

  const mimeType = String(opts.mimeType || 'application/octet-stream').split(';')[0];
  const fileName = opts.fileName || path.basename(filePath);
  let kind = mimeType.startsWith('image/') && /^image\/(jpeg|png)$/.test(mimeType)
    ? 'image'
    : mimeType.startsWith('video/') && /^video\/(mp4|3gpp)$/.test(mimeType)
      ? 'video'
      : mimeType.startsWith('audio/') && /^audio\/(aac|mp4|mpeg|amr|ogg)$/.test(mimeType)
        ? 'audio'
        : 'document'; // webp/gif e demais formatos vão como documento (a Meta não aceita como imagem)

  // Limites da Meta: foto 5 MB, vídeo/áudio 16 MB. Acima disso vai como documento (até 100 MB).
  const size = fs.statSync(filePath).size;
  const tooBig = (kind === 'image' && size > 5 * 1024 * 1024) || ((kind === 'video' || kind === 'audio') && size > 16 * 1024 * 1024);
  if (tooBig) kind = 'document';

  const mediaId = await uploadMedia(connection, filePath, mimeType, fileName);

  const payload = { messaging_product: 'whatsapp', to, recipient_type: 'individual', type: kind };
  payload[kind] = { id: mediaId };
  if (kind !== 'audio' && text) payload[kind].caption = text;
  if (kind === 'document') payload[kind].filename = fileName;

  const data = await graphRequest(`${connection.phoneNumberId}/messages`, {
    method: 'POST',
    token: connection.accessToken,
    body: payload
  });

  // Áudio não aceita legenda: se houver texto, vai logo em seguida.
  if (kind === 'audio' && text) {
    await sendMessage(connection, toPhone, text, null);
  }
  return { providerMessageId: data.messages?.[0]?.id || null };
}

/**
 * Envia uma mensagem de texto (ou com mídia, via link público). `connection`
 * é a linha do WhatsappConnection já com phoneNumberId e o token
 * descriptografado em `accessToken`.
 */
async function sendMessage(connection, toPhone, text, mediaFilePublicUrl) {
  const to = normalizePhoneDigits(toPhone);
  if (!to) {
    const err = new Error('Telefone do lead inválido ou vazio.');
    err.status = 400;
    throw err;
  }

  const payload = { messaging_product: 'whatsapp', to, recipient_type: 'individual' };

  if (mediaFilePublicUrl) {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(mediaFilePublicUrl);
    payload.type = isImage ? 'image' : 'document';
    payload[payload.type] = { link: mediaFilePublicUrl, caption: text || undefined };
  } else {
    payload.type = 'text';
    payload.text = { body: text || '', preview_url: true };
  }

  const data = await graphRequest(`${connection.phoneNumberId}/messages`, {
    method: 'POST',
    token: connection.accessToken,
    body: payload
  });

  return { providerMessageId: data.messages?.[0]?.id || null };
}

/**
 * Uma conexão Cloud API está "pronta" sempre que tem token e Phone Number ID
 * — não existe estado de QR/sessão aqui. Aceita tanto a linha crua do banco
 * (accessTokenEnc, só pra checar presença) quanto já descriptografada
 * (accessToken, na hora de enviar de verdade).
 */
function isReady(connection) {
  return connection.status === 'conectado' && !!connection.phoneNumberId && !!(connection.accessToken || connection.accessTokenEnc);
}

async function createConnection(userId, { instanceName, phoneNumberId, wabaId, accessToken, appSecret }) {
  if (!instanceName || !phoneNumberId || !accessToken) {
    const err = new Error('Nome, Phone Number ID e token de acesso são obrigatórios.');
    err.status = 400;
    throw err;
  }

  const info = await validateConnection({ phoneNumberId, accessToken });

  return prisma.whatsappConnection.create({
    data: {
      userId,
      instanceName,
      provider: 'cloud_api',
      status: 'conectado',
      phone: info.displayPhoneNumber,
      phoneNumberId,
      wabaId: wabaId || null,
      accessTokenEnc: encrypt(accessToken),
      appSecretEnc: appSecret ? encrypt(appSecret) : null,
      webhookVerifyToken: crypto.randomBytes(16).toString('hex')
    }
  });
}

async function updateConnection(userId, connectionId, { accessToken, appSecret }) {
  const existing = await prisma.whatsappConnection.findFirst({ where: { id: connectionId, userId, provider: 'cloud_api' } });
  if (!existing) {
    const err = new Error('Conexão não encontrada.');
    err.status = 404;
    throw err;
  }

  const newToken = accessToken || decrypt(existing.accessTokenEnc);
  const info = await validateConnection({ phoneNumberId: existing.phoneNumberId, accessToken: newToken });

  return prisma.whatsappConnection.update({
    where: { id: connectionId },
    data: {
      status: 'conectado',
      phone: info.displayPhoneNumber,
      accessTokenEnc: accessToken ? encrypt(accessToken) : existing.accessTokenEnc,
      appSecretEnc: appSecret ? encrypt(appSecret) : existing.appSecretEnc
    }
  });
}

/** Devolve a conexão já com o token (e app secret, se houver) descriptografados, prontos pra usar. */
async function loadDecrypted(connectionId) {
  const connection = await prisma.whatsappConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.provider !== 'cloud_api') return null;
  return {
    ...connection,
    accessToken: connection.accessTokenEnc ? decrypt(connection.accessTokenEnc) : null,
    appSecret: connection.appSecretEnc ? decrypt(connection.appSecretEnc) : null
  };
}

/** Confere a assinatura X-Hub-Signature-256 que a Meta manda em todo webhook, pra garantir que não é forjado. */
function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // sem app secret cadastrado, não dá pra validar — aceita (compatibilidade)
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

module.exports = {
  normalizePhoneDigits,
  validateConnection,
  sendMessage,
  sendMediaFile,
  downloadMedia,
  isReady,
  createConnection,
  updateConnection,
  loadDecrypted,
  verifyWebhookSignature
};
