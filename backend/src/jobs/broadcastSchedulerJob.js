// backend/src/jobs/broadcastSchedulerJob.js
const cron = require('node-cron');
const prisma = require('../config/db');
const { executeBroadcast, HEARTBEAT_STALE_MS } = require('../services/broadcastService');
const { getBlockedAccountIds } = require('../services/accessService');
const { getAccountIdsWithoutFeature } = require('../services/featureService');

// Contas bloqueadas OU cujo plano não inclui Disparos.
async function getSkippedAccountIds() {
  const [blocked, noFeature] = await Promise.all([getBlockedAccountIds(), getAccountIdsWithoutFeature('disparos')]);
  return [...new Set([...blocked, ...noFeature])];
}

const INTERVAL_MS = {
  diario: 24 * 60 * 60 * 1000,
  semanal: 7 * 24 * 60 * 60 * 1000,
  mensal: 30 * 24 * 60 * 60 * 1000
};

async function processDueBroadcasts() {
  const now = new Date();
  // Contas vencidas/bloqueadas não disparam nada (nem agendado, nem recorrente).
  const blocked = await getSkippedAccountIds();

  // Disparos imediatos que ficaram agendados por uma queda logo após a criação.
  const immediate = await prisma.broadcastCampaign.findMany({
    where: { status: 'agendado', scheduleType: 'now', userId: { notIn: blocked } },
    select: { id: true }
  });
  for (const broadcast of immediate) {
    await executeBroadcast(broadcast.id).catch((err) =>
      console.error(`Erro ao executar disparo imediato ${broadcast.id}:`, err.message)
    );
  }

  const scheduledDue = await prisma.broadcastCampaign.findMany({
    where: { status: 'agendado', scheduleType: 'scheduled', scheduledAt: { lte: now }, userId: { notIn: blocked } },
    select: { id: true }
  });
  for (const broadcast of scheduledDue) {
    await executeBroadcast(broadcast.id).catch((err) =>
      console.error(`Erro ao executar disparo agendado ${broadcast.id}:`, err.message)
    );
  }

  const recurringCandidates = await prisma.broadcastCampaign.findMany({
    where: { status: 'agendado', scheduleType: 'recurring', userId: { notIn: blocked } },
    select: { id: true, recurringInterval: true, lastRunAt: true, scheduledAt: true }
  });

  for (const broadcast of recurringCandidates) {
    const intervalMs = INTERVAL_MS[broadcast.recurringInterval] || INTERVAL_MS.semanal;
    const dueSinceLastRun =
      !broadcast.lastRunAt || now.getTime() - new Date(broadcast.lastRunAt).getTime() >= intervalMs;
    const startReached = !broadcast.scheduledAt || new Date(broadcast.scheduledAt) <= now;

    if (dueSinceLastRun && startReached) {
      await executeBroadcast(broadcast.id).catch((err) =>
        console.error(`Erro ao executar disparo recorrente ${broadcast.id}:`, err.message)
      );
    }
  }
}

async function recoverOrphanedBroadcasts() {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const blocked = await getSkippedAccountIds();

  const orphaned = await prisma.broadcastCampaign.findMany({
    where: {
      isRunning: true,
      userId: { notIn: blocked },
      OR: [{ lastHeartbeatAt: { lt: staleBefore } }, { lastHeartbeatAt: null }]
    },
    select: { id: true, name: true }
  });

  for (const broadcast of orphaned) {
    console.log(`🔄 Retomando disparo órfão "${broadcast.name}" (${broadcast.id})...`);
    await executeBroadcast(broadcast.id).catch((err) =>
      console.error(`Erro ao retomar disparo órfão ${broadcast.id}:`, err.message)
    );
  }
}

function startBroadcastSchedulerJob() {
  // A cada minuto: reduz a janela de recuperação de campanhas imediatas,
  // agendadas e recorrentes.
  cron.schedule('* * * * *', () => {
    processDueBroadcasts().catch((err) => console.error('❌ Erro no scheduler de disparos:', err));
  });

  // A cada minuto também verificamos processos órfãos. O heartbeat de 30s
  // impede que uma execução viva seja considerada órfã durante uma pausa.
  cron.schedule('* * * * *', () => {
    recoverOrphanedBroadcasts().catch((err) => console.error('❌ Erro no watchdog de disparos:', err));
  });

  console.log('✅ Scheduler de disparos ativo (1 min)');
  console.log('✅ Watchdog de recuperação ativo (1 min)');
}

module.exports = { startBroadcastSchedulerJob, processDueBroadcasts, recoverOrphanedBroadcasts };