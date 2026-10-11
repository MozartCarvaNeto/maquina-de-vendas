// backend/src/services/whatsapp/whatsappIncomingService.js
//
// O que fazer quando chega uma mensagem de um lead — igual para as duas
// conexões (QR Code e API Oficial da Meta): acha ou cria o lead, salva a
// mensagem, avisa a tela em tempo real e dispara a resposta automática da
// IA quando configurada. A sessão nativa tem a própria cópia dessa lógica
// (não mexi nela); esta aqui é usada pela API Oficial.
const prisma = require('../../config/db');

async function processIncomingMessage({ userId, connectionId, phone, text, contactName, sendReply, referral }) {
  if (!phone || !text) return;

  let lead = await prisma.lead.findFirst({ where: { userId, phone: { contains: phone } } });

  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        userId,
        name: contactName || phone,
        phone,
        consentSource: 'whatsapp_organico',
        status: 'novo'
      }
    });
  }

  const savedMessage = await prisma.message.create({
    data: { leadId: lead.id, direction: 'entrada', channel: 'whatsapp', body: text }
  });

  const io = global.socketIoInstance;
  if (io) io.to(`user:${userId}`).emit('whatsapp:message', { leadId: lead.id, message: savedMessage });

  await require('../campaignBotService').handleIncoming({ userId, connectionId, lead, text, referral, sendReply });
}

module.exports = { processIncomingMessage };
