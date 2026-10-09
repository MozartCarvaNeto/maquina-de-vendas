// backend/src/services/whatsapp/whatsappDispatcher.js
//
// Ponto único de envio de WhatsApp: olha o "provider" da conexão escolhida
// e manda pro motor certo — sessão nativa (QR Code) ou API Oficial da Meta.
// Todo o resto do sistema (disparos, ligações robô, chat) passa a chamar
// só este arquivo, em vez de falar direto com cada motor.
const prisma = require('../../config/db');
const nativeWhatsappService = require('./nativeWhatsappService');
const metaCloudApiService = require('./metaCloudApiService');
const env = require('../../config/env');

function isReady(connection) {
  if (!connection) return false;
  if (connection.provider === 'cloud_api') return metaCloudApiService.isReady(connection);
  return nativeWhatsappService.isReady(connection.id);
}

/**
 * @param {object} connection - a linha do WhatsappConnection (precisa ter o
 *   campo `accessToken` já descriptografado quando for cloud_api — use
 *   `loadConnectionForSending` abaixo pra isso).
 */
async function sendMessage(connection, toPhone, text, mediaFilePath) {
  if (connection.provider === 'cloud_api') {
    // A Meta não aceita enviar um arquivo do seu disco — ela busca por uma
    // URL pública. Como o backend já serve /uploads publicamente, isso
    // funciona sem precisar subir o arquivo pra Meta antes.
    const mediaUrl = mediaFilePath
      ? `${env.backendPublicUrl.replace(/\/$/, '')}/uploads/${require('path').basename(mediaFilePath)}`
      : null;
    return metaCloudApiService.sendMessage(connection, toPhone, text, mediaUrl);
  }
  return nativeWhatsappService.sendMessage(connection.id, toPhone, text, mediaFilePath);
}

/** Carrega a conexão já pronta pra enviar — com o token descriptografado, se for cloud_api. */
async function loadConnectionForSending(connectionId) {
  const connection = await prisma.whatsappConnection.findUnique({ where: { id: connectionId } });
  if (!connection) return null;
  if (connection.provider === 'cloud_api') {
    const decrypted = await metaCloudApiService.loadDecrypted(connectionId);
    return decrypted || connection;
  }
  return connection;
}

/** Lista as conexões de um usuário que estão prontas pra mandar mensagem agora, dos dois tipos. */
async function listReadyConnections(userId) {
  const rows = await prisma.whatsappConnection.findMany({ where: { userId, status: 'conectado' } });
  const ready = [];
  for (const row of rows) {
    if (row.provider === 'cloud_api') {
      if (metaCloudApiService.isReady(row)) ready.push(row); // não precisa do token aqui, só pra listar
    } else if (nativeWhatsappService.isReady(row.id)) {
      ready.push(row);
    }
  }
  return ready;
}

module.exports = { isReady, sendMessage, loadConnectionForSending, listReadyConnections };
