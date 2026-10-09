// backend/src/jobs/aiCallWatchdogJob.js
//
// Se o servidor reiniciou no meio de uma campanha do agente de IA, retoma de
// onde parou: só liga para quem ainda não recebeu ligação desta campanha.
const cron = require('node-cron');
const prisma = require('../config/db');
const { HEARTBEAT_STALE_MS } = require('../services/broadcastService');
const { executeAiCampaign } = require('../services/ai/voice/aiCallService');

function startAiCallWatchdogJob() {
  cron.schedule('* * * * *', async () => {
    try {
      const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
      const stuck = await prisma.aiCallCampaign.findMany({
        where: {
          status: 'discando',
          OR: [{ isRunning: false }, { isRunning: true, lastHeartbeatAt: { lt: staleBefore } }]
        },
        select: { id: true }
      });
      for (const campaign of stuck) {
        console.log(`♻️ Retomando campanha do agente IA ${campaign.id}`);
        executeAiCampaign(campaign.id).catch((err) => console.error('Erro ao retomar campanha do agente IA:', err.message));
      }
    } catch (error) {
      console.error('Erro no watchdog do agente IA:', error.message);
    }
  });
  console.log('✅ Watchdog do agente de voz IA ativo (1 min)');
}

module.exports = { startAiCallWatchdogJob };
