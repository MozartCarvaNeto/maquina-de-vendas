// backend/src/services/whatsapp/whatsappIncomingService.js
//
// O que fazer quando chega uma mensagem de um lead — igual para as duas
// conexões (QR Code e API Oficial da Meta): acha ou cria o lead, salva a
// mensagem, avisa a tela em tempo real e dispara a resposta automática da
// IA quando configurada. A sessão nativa tem a própria cópia dessa lógica
// (não mexi nela); esta aqui é usada pela API Oficial.
const prisma = require('../../config/db');

async function processIncomingMessage({ userId, connectionId, phone, text, contactName, sendReply }) {
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

  if (lead.campaignId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: lead.campaignId } });
    if (campaign?.botPrompt) {
      await tryAutoReply({ userId, connectionId, lead, campaign, incomingText: text, sendReply });
    }
  }
}

async function tryAutoReply({ userId, connectionId, lead, campaign, incomingText, sendReply }) {
  try {
    const { getActiveAiProvider } = require('../ai/aiProviderFactory');
    const aiProvider = await getActiveAiProvider(userId, campaign.aiProviderOverride);
    if (!aiProvider) return;

    const history = await prisma.message.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: 'asc' }, take: 20 });
    const aiHistory = history.slice(0, -1).map((m) => ({ role: m.direction === 'entrada' ? 'user' : 'model', text: m.body }));

    const replyText = await aiProvider.generateReply(campaign.botPrompt, aiHistory, incomingText);
    await sendReply(replyText);

    const savedReply = await prisma.message.create({
      data: { leadId: lead.id, direction: 'saida', channel: 'whatsapp', body: replyText }
    });

    const io = global.socketIoInstance;
    if (io) io.to(`user:${userId}`).emit('whatsapp:message', { leadId: lead.id, message: savedReply });
  } catch (error) {
    console.error(`Erro na resposta automática (conexão ${connectionId}):`, error.message);
  }
}

module.exports = { processIncomingMessage };
