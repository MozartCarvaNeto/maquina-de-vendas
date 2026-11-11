// backend/src/services/referralService.js
// Indicação (afiliados): cada conta tem um código/link. Quando uma conta
// indicada paga a PRIMEIRA mensalidade, quem indicou ganha um bônus em saldo
// da carteira (% do valor pago, definido pelo administrador). Uma vez por conta indicada.
const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const { readStoredCredentials, persistCredentials } = require('./settingsHelpers');

const CATEGORY = 'platform_telecom';
const PROVIDER = 'referral';
const DEFAULTS = { enabled: true, percent: 10, maxBonusBrl: 200 };

async function platformId() {
  return (await require('./platformService').platformAccountIds())[0] || null;
}

async function getSettings() {
  const pid = await platformId();
  if (!pid) return { ...DEFAULTS };
  const v = await readStoredCredentials(pid, CATEGORY, PROVIDER).catch(() => ({}));
  try { return { ...DEFAULTS, ...(v.doc ? JSON.parse(v.doc) : {}) }; } catch (_) { return { ...DEFAULTS }; }
}

async function saveSettings(input = {}) {
  const pid = await platformId();
  if (!pid) throw Object.assign(new Error('Nenhuma conta de administrador da plataforma encontrada (SUPERADMIN_EMAILS).'), { status: 400 });
  const percent = Number(input.percent);
  const maxBonusBrl = Number(input.maxBonusBrl);
  if (!(percent >= 0 && percent <= 100)) throw Object.assign(new Error('Percentual deve ficar entre 0 e 100.'), { status: 400 });
  if (!(maxBonusBrl >= 0)) throw Object.assign(new Error('Teto de bônus inválido.'), { status: 400 });
  const doc = { enabled: input.enabled !== false, percent, maxBonusBrl };
  await persistCredentials(pid, CATEGORY, PROVIDER, { doc: JSON.stringify(doc) }, [], { exclusive: false });
  return doc;
}

function newCode() {
  return crypto.randomBytes(5).toString('hex').slice(0, 8).toUpperCase();
}

async function ensureCode(accountId) {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (acc.referralCode) return acc.referralCode;
  for (let i = 0; i < 5; i++) {
    try {
      const code = newCode();
      await prisma.account.update({ where: { id: accountId }, data: { referralCode: code } });
      return code;
    } catch (e) {
      if (e.code !== 'P2002') throw e;
    }
  }
  throw new Error('Não foi possível gerar o código de indicação.');
}

/** Cadastro: devolve o id de quem indicou (ou null se o código não existir). */
async function resolveReferrer(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(c)) return null;
  const acc = await prisma.account.findUnique({ where: { referralCode: c }, select: { id: true } });
  return acc ? acc.id : null;
}

/** Chamado quando um pagamento é confirmado. Nunca lança erro (não pode atrapalhar a cobrança). */
async function rewardOnPayment(account, amountCents) {
  try {
    if (!account.referredById || account.referralRewardedAt) return null;
    const s = await getSettings();
    if (!s.enabled || !(s.percent > 0)) return null;
    const bonus = Math.min(s.maxBonusBrl, (amountCents / 100) * (s.percent / 100));
    if (!(bonus > 0)) return null;
    const claim = await prisma.account.updateMany({
      where: { id: account.id, referralRewardedAt: null },
      data: { referralRewardedAt: new Date(), referralRewardBrl: Math.round(bonus * 100) / 100 }
    });
    if (claim.count !== 1) return null;
    await require('./walletService').credit(account.referredById, Math.round(bonus * 100) / 100, {
      type: 'bonus',
      description: `Bônus de indicação: ${account.name}`,
      refId: account.id
    });
    return bonus;
  } catch (err) {
    console.warn('Bônus de indicação não aplicado:', err.message);
    return null;
  }
}

async function overview(accountId) {
  const [code, s, referred] = await Promise.all([
    ensureCode(accountId),
    getSettings(),
    prisma.account.findMany({
      where: { referredById: accountId },
      select: { name: true, createdAt: true, referralRewardedAt: true, referralRewardBrl: true },
      orderBy: { createdAt: 'desc' },
      take: 200
    })
  ]);
  return {
    enabled: s.enabled && s.percent > 0,
    percent: s.percent,
    maxBonusBrl: s.maxBonusBrl,
    code,
    link: `${env.frontendUrl.replace(/\/$/, '')}/registrar?ref=${code}`,
    totalEarnedBrl: referred.reduce((n, r) => n + (r.referralRewardBrl || 0), 0),
    referred: referred.map((r) => ({
      name: r.name.slice(0, 3) + '***', // privacidade do indicado
      createdAt: r.createdAt,
      paid: !!r.referralRewardedAt,
      bonusBrl: r.referralRewardBrl || 0
    }))
  };
}

module.exports = { getSettings, saveSettings, ensureCode, resolveReferrer, rewardOnPayment, overview };
