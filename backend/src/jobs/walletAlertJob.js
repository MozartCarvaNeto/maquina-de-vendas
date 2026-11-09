// backend/src/jobs/walletAlertJob.js
// A cada 15 min avisa por e-mail quem está com saldo baixo (no máximo 1 aviso por dia; zera quando o cliente recarrega).
const cron = require('node-cron');

async function runNow() {
  const prisma = require('../config/db');
  const rules = await require('../services/platformBillingSettings').get(true);
  const platform = new Set(await require('../services/platformService').platformAccountIds());
  const wallets = await prisma.wallet.findMany({ where: { enabled: true }, take: 20000 });
  const mailer = require('../services/email/systemMailer');
  const env = require('../config/env');
  const sent = [];
  for (const w of wallets) {
    if (platform.has(w.userId)) continue;
    const limit = w.lowBalanceBrl ?? rules.walletLowDefaultBrl;
    if (!(limit > 0)) continue;
    if (w.balanceBrl > limit) {
      if (w.lowNotifiedAt) await prisma.wallet.update({ where: { userId: w.userId }, data: { lowNotifiedAt: null } });
      continue;
    }
    if (w.lowNotifiedAt && Date.now() - new Date(w.lowNotifiedAt).getTime() < 24 * 3600 * 1000) continue;
    const owner = await prisma.member.findFirst({ where: { accountId: w.userId, role: 'owner' }, select: { email: true, name: true } });
    // marca antes de enviar: se o e-mail falhar, tenta de novo só amanhã (sem repetir a cada 15 min)
    await prisma.wallet.update({ where: { userId: w.userId }, data: { lowNotifiedAt: new Date() } });
    if (!owner?.email) continue;
    const link = `${(env.frontendUrl || env.backendPublicUrl || '').replace(/\/$/, '')}/gateway`;
    const html = mailer.buildActionEmail({
      greeting: `Olá${owner.name ? `, ${owner.name}` : ''}!`,
      intro: `Seu saldo está em R$ ${Number(w.balanceBrl).toFixed(2)} (aviso abaixo de R$ ${Number(limit).toFixed(2)}). Quando zerar, os envios de SMS e as ligações são bloqueados. Recarregue por Pix ou cartão em Gateway de telecom > Saldo.`,
      buttonText: 'Recarregar agora', url: link, footer: 'Você recebe este aviso no máximo uma vez por dia.'
    });
    await mailer.sendSystemEmail({ to: owner.email, subject: `Saldo baixo — ${env.appName}`, html, accountId: w.userId }).then(() => sent.push(w.userId)).catch((e) => console.warn('Aviso de saldo baixo:', e.message));
  }
  return { sent };
}

function startWalletAlertJob() {
  cron.schedule('*/15 * * * *', () => runNow().catch((e) => console.error('❌ Aviso de saldo baixo:', e.message)));
  console.log('✅ Aviso de saldo baixo ativo (15 min)');
}

module.exports = { startWalletAlertJob, runNow };
