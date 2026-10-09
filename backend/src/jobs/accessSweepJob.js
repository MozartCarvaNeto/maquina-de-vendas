// backend/src/jobs/accessSweepJob.js
//
// A cada 5 minutos confere quem venceu/foi bloqueado e encerra, no servidor, o
// que ainda estiver rodando em segundo plano para essas contas (sessões de
// WhatsApp). O bloqueio de login em si não depende deste job: ele é imediato.
const cron = require('node-cron');
const { sweepBlockedAccounts } = require('../services/accessService');

function startAccessSweepJob() {
  cron.schedule('*/5 * * * *', () => {
    sweepBlockedAccounts().catch((err) => console.error('❌ Erro na varredura de acessos:', err.message));
  });
  console.log('✅ Varredura de assinaturas vencidas ativa (5 min)');
}

module.exports = { startAccessSweepJob };
