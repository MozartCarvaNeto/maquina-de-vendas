// backend/src/jobs/didJob.js
// Rotinas dos números de entrada, sem depender de ninguém abrir a tela:
//  - a cada 10 min: dá número do estoque aos clientes ativos que ainda não têm (se a atribuição automática estiver ligada);
//  - a cada hora: cobra as mensalidades vencidas, suspende quem passou da carência e reativa quem pagou.
const cron = require('node-cron');

async function applyFor(ids) {
  const svc = require('../services/pbx/pbxService');
  const plat = await require('../services/platformService').platformAccountIds();
  for (const id of [...new Set([...ids, ...plat])]) await svc.applyConfig(id).catch((e) => console.warn(`Aplicar Asterisk (${id}):`, e.message));
}

async function runSweepNow() {
  const dids = require('../services/pbx/didService');
  const res = await dids.autoAssignSweep();
  if (res.accounts.length) await applyFor(res.accounts);
  return res;
}

async function runBillingNow() {
  const dids = require('../services/pbx/didService');
  const res = await dids.runBilling();
  if (res.changedAccounts.length) await applyFor(res.changedAccounts);
  return res;
}

function startDidJobs() {
  cron.schedule('*/10 * * * *', () => runSweepNow().catch((e) => console.error('❌ Atribuição automática de números:', e.message)));
  cron.schedule('5 * * * *', () => runBillingNow().catch((e) => console.error('❌ Mensalidade dos números:', e.message)));
  setTimeout(() => runSweepNow().then(() => runBillingNow()).catch((e) => console.error('Números (partida):', e.message)), 20000);
  console.log('✅ Atribuição automática (10 min) e mensalidade dos números (1 h) ativas');
}

module.exports = { startDidJobs, runSweepNow, runBillingNow };
