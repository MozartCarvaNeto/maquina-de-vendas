// backend/src/services/platformBillingSettings.js
// Regras comerciais da plataforma (só o administrador muda): custos pagos ao fornecedor, recarga e aviso de saldo baixo.
const { readStoredCredentials, persistCredentials } = require('./settingsHelpers');

const CATEGORY = 'platform_telecom';
const PROVIDER = 'billing_rules';
const DEFAULTS = {
  voiceCostOutPerMinBrl: 0, voiceCostInPerMinBrl: 0, voiceCostIncrementSec: 60, didCostMonthlyBrl: 0, smsCostFallbackBrl: 0, whatsappPriceBrl: 0, whatsappCostBrl: 0,
  walletLowDefaultBrl: 10, topupEnabled: true, topupMinBrl: 10, topupMaxBrl: 5000, topupAutoEnable: true
};
let cache = null;
let cacheAt = 0;

const num = (v, d, min = 0, max = 1e7) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

async function platformId() {
  return (await require('./platformService').platformAccountIds())[0] || null;
}

async function get(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60000) return cache;
  const pid = await platformId();
  const v = pid ? await readStoredCredentials(pid, CATEGORY, PROVIDER).catch(() => ({})) : {};
  cache = {
    voiceCostOutPerMinBrl: num(v.voiceCostOutPerMinBrl, DEFAULTS.voiceCostOutPerMinBrl, 0, 1000),
    voiceCostInPerMinBrl: num(v.voiceCostInPerMinBrl, DEFAULTS.voiceCostInPerMinBrl, 0, 1000),
    voiceCostIncrementSec: [1, 6, 30, 60].includes(Number(v.voiceCostIncrementSec)) ? Number(v.voiceCostIncrementSec) : DEFAULTS.voiceCostIncrementSec,
    didCostMonthlyBrl: num(v.didCostMonthlyBrl, DEFAULTS.didCostMonthlyBrl, 0, 100000),
    smsCostFallbackBrl: num(v.smsCostFallbackBrl, DEFAULTS.smsCostFallbackBrl, 0, 1000),
    whatsappPriceBrl: num(v.whatsappPriceBrl, DEFAULTS.whatsappPriceBrl, 0, 1000),
    whatsappCostBrl: num(v.whatsappCostBrl, DEFAULTS.whatsappCostBrl, 0, 1000),
    walletLowDefaultBrl: num(v.walletLowDefaultBrl, DEFAULTS.walletLowDefaultBrl, 0, 100000),
    topupEnabled: v.topupEnabled === undefined ? DEFAULTS.topupEnabled : v.topupEnabled === 'true',
    topupMinBrl: num(v.topupMinBrl, DEFAULTS.topupMinBrl, 1, 100000),
    topupMaxBrl: num(v.topupMaxBrl, DEFAULTS.topupMaxBrl, 1, 1e6),
    topupAutoEnable: v.topupAutoEnable === undefined ? DEFAULTS.topupAutoEnable : v.topupAutoEnable === 'true'
  };
  cacheAt = Date.now();
  return cache;
}

async function save(input = {}) {
  const pid = await platformId();
  if (!pid) throw Object.assign(new Error('Nenhuma conta de administrador da plataforma encontrada (SUPERADMIN_EMAILS).'), { status: 400 });
  const cur = await get(true);
  const next = { ...cur, ...input };
  const merged = {};
  for (const k of Object.keys(DEFAULTS)) merged[k] = String(typeof DEFAULTS[k] === 'boolean' ? (next[k] === true || next[k] === 'true') : next[k]);
  if (Number(merged.topupMaxBrl) < Number(merged.topupMinBrl)) throw Object.assign(new Error('O valor máximo da recarga não pode ser menor que o mínimo.'), { status: 400 });
  await persistCredentials(pid, CATEGORY, PROVIDER, merged, [], { exclusive: false });
  return get(true);
}

module.exports = { get, save, DEFAULTS, _reset: () => { cache = null; } };
