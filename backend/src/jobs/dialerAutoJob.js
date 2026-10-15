// backend/src/jobs/dialerAutoJob.js
//
// Motor do Discador Automático: a cada poucos segundos, para cada conta com o "Modo automático" ligado,
// liga para o próximo lead da fila SE houver vendedor livre (ver dialerQueueService).
const prisma = require('../config/db');
const { getCredentials } = require('../services/integrationFactory');
const { runDialerTick } = require('../services/dialerQueueService');
const { isAccountBlocked } = require('../services/accessService');
const { accountHasFeature } = require('../services/featureService');

const TICK_MS = 4000;
const RESCAN_MS = 60 * 1000;

const enabled = new Set(); // contas com o modo automático ligado
let lastScan = 0;
let running = false;

/** Chamado quando o usuário liga/desliga o modo automático, para valer na hora. */
function markAccountAutoDial(userId, isOn) {
  if (isOn) enabled.add(userId);
  else enabled.delete(userId);
}

async function rescan() {
  const rows = await prisma.setting.findMany({
    where: { category: 'dialer', isActive: true },
    select: { userId: true },
    distinct: ['userId']
  });
  const next = new Set();
  for (const { userId } of rows) {
    const settings = await getCredentials(userId, 'dialer').catch(() => null);
    if (settings?.autoDialEnabled === 'true') next.add(userId);
  }
  enabled.clear();
  next.forEach((id) => enabled.add(id));
  lastScan = Date.now();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    if (Date.now() - lastScan > RESCAN_MS) await rescan();
    for (const userId of [...enabled]) {
      // Conta bloqueada ou sem o módulo Discador não disca.
      if ((await isAccountBlocked(userId)) || !(await accountHasFeature(userId, 'discador'))) continue;
      const keepGoing = await runDialerTick(userId);
      if (keepGoing === false) enabled.delete(userId);
    }
  } catch (error) {
    console.error('Erro no motor do discador automático:', error.message);
  } finally {
    running = false;
  }
}

function startDialerAutoJob() {
  rescan().catch((error) => console.error('Discador automático: falha ao ler configurações:', error.message));
  setInterval(() => tick().catch(() => {}), TICK_MS);
  console.log('✅ Discador automático (equipe de vendedores) ativo');
}

module.exports = { startDialerAutoJob, markAccountAutoDial };
