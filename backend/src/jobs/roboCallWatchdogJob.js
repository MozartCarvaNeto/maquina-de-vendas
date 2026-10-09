// backend/src/jobs/roboCallWatchdogJob.js
//
// Se o servidor reiniciou (ou caiu) no meio de uma campanha de ligações robô,
// retoma de onde parou: só liga para quem ainda não foi ligado.
const cron = require('node-cron');
const prisma = require('../config/db');
const { HEARTBEAT_STALE_MS } = require('../services/broadcastService');
const { executeRoboCampaign } = require('../services/roboCallService');

function startRoboCallWatchdogJob() {
  cron.schedule('* * * * *', async () => {
    try {
      const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
      const stuck = await prisma.roboCallCampaign.findMany({
        where: {
          status: 'discando',
          OR: [{ isRunning: false }, { isRunning: true, lastHeartbeatAt: { lt: staleBefore } }]
        },
        select: { id: true }
      });
      for (const campaign of stuck) {
        console.log(`♻️ Retomando campanha de ligações robô ${campaign.id}`);
        executeRoboCampaign(campaign.id).catch((err) => console.error('Erro ao retomar campanha robô:', err.message));
      }
    } catch (error) {
      console.error('Erro no watchdog de ligações robô:', error.message);
    }
  });
  console.log('✅ Watchdog de ligações robô ativo (1 min)');
}

module.exports = { startRoboCallWatchdogJob };
