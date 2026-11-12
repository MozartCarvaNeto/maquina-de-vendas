// backend/src/jobs/autoRechargeJob.js — a cada 5 min cobra no cartão salvo quem ficou abaixo do limite
const cron = require('node-cron');

function startAutoRechargeJob() {
  cron.schedule('*/5 * * * *', () => require('../services/autoRechargeService').runNow().catch((e) => console.error('❌ Recarga automática:', e.message)));
  console.log('✅ Recarga automática ativa (5 min)');
}
module.exports = { startAutoRechargeJob };
