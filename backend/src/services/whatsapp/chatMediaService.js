// backend/src/services/whatsapp/chatMediaService.js
//
// Guarda no disco (e descreve) as fotos, documentos, áudios e vídeos que
// entram e saem pelo Chat. Os arquivos ficam em uploads/chat-media/<conta>/
// e NÃO são públicos: só são entregues pela rota autenticada
// GET /api/whatsapp/messages/:id/media.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_ROOT = path.join(__dirname, '../../../uploads/chat-media');

// Limites do próprio WhatsApp: ~16 MB para foto/vídeo/áudio, 100 MB para documento.
// Usamos 16 MB no envio para não estourar a memória do servidor.
const MAX_SEND_BYTES = 100 * 1024 * 1024; // documentos: até 100 MB
// Foto/vídeo/áudio acima disso vão como documento (o WhatsApp só aceita 16 MB como mídia).
const MAX_INLINE_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_RECEIVE_BYTES = 100 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/amr': '.amr', 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/mp3': '.mp3', 'audio/x-m4a': '.m4a', 'audio/opus': '.opus',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/zip': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
};

// Extensões que nunca devem ser guardadas/enviadas (executáveis e scripts).
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|js|jse|vbs|ps1|sh|jar|apk|dll|php|html?|svg)$/i;

function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** image | video | audio | document */
function classify(mime) {
  const m = baseMime(mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function extensionFor(mime, originalName) {
  const fromName = path.extname(String(originalName || '')).toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,8}$/.test(fromName) && !BLOCKED_EXT.test(fromName)) return fromName;
  return MIME_EXT[baseMime(mime)] || '.bin';
}

function safeFileName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/\r\n\t"<>|:*?]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Valida um arquivo que o usuário quer enviar. Devolve mensagem de erro ou null. */
function validateOutgoing(file) {
  const size = file ? file.size ?? file.buffer?.length ?? 0 : 0;
  if (!file || size === 0) return 'O arquivo está vazio.';
  if (size > MAX_SEND_BYTES) return 'O arquivo ultrapassa o limite de 100 MB do WhatsApp.';
  if (BLOCKED_EXT.test(String(file.originalname || ''))) {
    return 'Este tipo de arquivo (executável/script) não pode ser enviado.';
  }
  return null;
}

/**
 * Grava o arquivo e devolve os campos para salvar na Message.
 * `accountId` separa as pastas de cada cliente.
 */
function saveBuffer(accountId, buffer, mime, originalName) {
  const mimeType = baseMime(mime) || 'application/octet-stream';
  const ext = extensionFor(mimeType, originalName);
  const dir = path.join(MEDIA_ROOT, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);
  const type = classify(mimeType);
  return {
    mediaType: type,
    mediaPath: `${accountId}/${stored}`,
    mediaMime: mimeType,
    mediaName: safeFileName(originalName, `${type}${ext}`),
    mediaSize: buffer.length
  };
}

/** Igual ao saveBuffer, mas para um arquivo já gravado em disco (upload grande). Apaga o temporário. */
function saveFromDisk(accountId, tmpPath, size, mime, originalName) {
  const mimeType = baseMime(mime) || 'application/octet-stream';
  const ext = extensionFor(mimeType, originalName);
  const dir = path.join(MEDIA_ROOT, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${crypto.randomUUID()}${ext}`;
  fs.copyFileSync(tmpPath, path.join(dir, stored));
  fs.rmSync(tmpPath, { force: true });
  const type = classify(mimeType);
  return {
    mediaType: type,
    mediaPath: `${accountId}/${stored}`,
    mediaMime: mimeType,
    mediaName: safeFileName(originalName, `${type}${ext}`),
    mediaSize: size
  };
}

/** Caminho absoluto de um mediaPath, garantindo que não escapa da pasta. */
function resolvePath(mediaPath) {
  if (!mediaPath) return null;
  const full = path.resolve(MEDIA_ROOT, mediaPath);
  if (!full.startsWith(path.resolve(MEDIA_ROOT) + path.sep)) return null;
  return full;
}

/** Texto curto para a lista de conversas quando a mensagem não tem legenda. */
function previewLabel(message) {
  if (message.body) return message.body;
  switch (message.mediaType) {
    case 'image': return '📷 Foto';
    case 'video': return '🎥 Vídeo';
    case 'audio': return '🎤 Áudio';
    case 'document': return `📄 ${message.mediaName || 'Documento'}`;
    default: return '';
  }
}

// Tipos aceitos como anexo de disparo/chat (foto, vídeo mp4, PDF, Office, texto, zip).
const ALLOWED_ATTACHMENT = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|quicktime)|application\/pdf|application\/zip|application\/msword|application\/vnd\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\.[a-z.]+)|text\/(plain|csv))$/;

function isAllowedAttachment(file) {
  if (!file) return false;
  if (BLOCKED_EXT.test(String(file.originalname || ''))) return false;
  return ALLOWED_ATTACHMENT.test(baseMime(file.mimetype));
}

module.exports = {
  isAllowedAttachment,
  MEDIA_ROOT,
  MAX_SEND_BYTES,
  MAX_INLINE_MEDIA_BYTES,
  saveFromDisk,
  MAX_RECEIVE_BYTES,
  classify,
  validateOutgoing,
  saveBuffer,
  resolvePath,
  previewLabel,
  baseMime,
  safeFileName
};
