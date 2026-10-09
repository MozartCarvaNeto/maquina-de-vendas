// backend/src/jobs/followUpNurtureJob.js
const cron = require('node-cron');
const prisma = require('../config/db');
const nativeWhatsappService = require('../services/whatsapp/nativeWhatsappService');
const { getBlockedAccountIds } = require('../services/accessService');
const { getAccountIdsWithoutFeature } = require('../services/featureService');

async function sendAutoMessage(lead, text) {
  try {
    const connection = await prisma.whatsappConnection.findFirst({
      where: { userId: lead.userId, status: 'conectado' }
    });
    if (!connection) {
      console.warn(`Lead ${lead.id}: nenhuma conexão WhatsApp ativa, follow-up não enviado`);
      return;
    }

    await nativeWhatsappService.sendMessage(connection.id, lead.phone, text);

    const message = await prisma.message.create({
      data: { leadId: lead.id, direction: 'saida', channel: 'whatsapp', body: text }
    });

    const io = global.socketIoInstance;
    if (io) {
      io.to(`user:${lead.userId}`).emit('whatsapp:message', { leadId: lead.id, message });
    }
  } catch (error) {
    console.error(`Erro ao enviar mensagem automática para lead ${lead.id}:`, error.message);
  }
}

async function processFollowUpsAndNurture() {
  // Contas vencidas/bloqueadas não recebem follow-ups automáticos.
  // Também ignora contas cujo plano não inclui Contatos/Campanhas e Conexões.
  const [blockedAccess, noContacts, noWhatsapp] = await Promise.all([
    getBlockedAccountIds(),
    getAccountIdsWithoutFeature('contatos'),
    getAccountIdsWithoutFeature('conexoes')
  ]);
  const blocked = [...new Set([...blockedAccess, ...noContacts, ...noWhatsapp])];
  const candidates = await prisma.lead.findMany({
    where: {
      userId: { notIn: blocked },
      optOut: false,
      status: { notIn: ['fechado', 'perdido', 'desqualificado'] },
      campaign: { followUpEnabled: true }
    },
    include: {
      campaign: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 }
    }
  });

  let followUpsSent = 0;
  let nurturesSent = 0;

  for (const lead of candidates) {
    const lastMessage = lead.messages[0];
    if (!lastMessage || lastMessage.direction !== 'saida') continue;
    if (!lead.campaign || !lead.phone) continue;

    const daysSinceLastOutbound = Math.floor(
      (Date.now() - new Date(lastMessage.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    const followUpDays = lead.campaign.followUpDays || 7;
    const nutritionDays = lead.campaign.nutritionDays || 30;

    const alreadyFollowedUpForThisSilence =
      lead.lastFollowUpAt && new Date(lead.lastFollowUpAt) > new Date(lastMessage.createdAt);

    if (
      daysSinceLastOutbound >= followUpDays &&
      daysSinceLastOutbound < nutritionDays &&
      !alreadyFollowedUpForThisSilence &&
      lead.campaign.followUpMessage
    ) {
      await sendAutoMessage(lead, lead.campaign.followUpMessage);
      await prisma.lead.update({ where: { id: lead.id }, data: { lastFollowUpAt: new Date() } });
      followUpsSent += 1;
      continue;
    }

    const nurtureCycleElapsed =
      !lead.lastNurtureAt ||
      Date.now() - new Date(lead.lastNurtureAt).getTime() >= nutritionDays * 24 * 60 * 60 * 1000;

    if (daysSinceLastOutbound >= nutritionDays && nurtureCycleElapsed && lead.campaign.nutritionMessage) {
      await sendAutoMessage(lead, lead.campaign.nutritionMessage);
      await prisma.lead.update({ where: { id: lead.id }, data: { lastNurtureAt: new Date() } });
      nurturesSent += 1;
    }
  }

  console.log(`⏰ Job de follow-up/nutrição concluído: ${followUpsSent} follow-ups, ${nurturesSent} nutrições enviadas`);
}

function startFollowUpNurtureJob() {
  cron.schedule(
    '0 9 * * *',
    () => {
      processFollowUpsAndNurture().catch((err) =>
        console.error('❌ Erro no job de follow-up/nutrição:', err)
      );
    },
    { timezone: 'America/Sao_Paulo' }
  );

  console.log('✅ Job de follow-up/nutrição agendado (todo dia às 09:00, horário de Brasília)');
}

module.exports = { startFollowUpNurtureJob, processFollowUpsAndNurture };