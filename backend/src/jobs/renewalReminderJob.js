// backend/src/jobs/renewalReminderJob.js
// Todo dia às 9h (Brasília) avisa o dono por e-mail: 7, 3 e 1 dia antes do vencimento, no dia, e 2 dias depois.
// Cada aviso sai uma vez por vencimento (marcado em usage_counters, sem tabela nova).
const cron = require('node-cron');

const STEPS = [7, 3, 1, 0, -2];

async function runNow(now = new Date()) {
  const prisma = require('../config/db');
  const mailer = require('../services/email/systemMailer');
  const env = require('../config/env');
  const { computeAccess, isPlatformAdminEmail } = require('../services/accessService');
  const accounts = await prisma.account.findMany({
    where: { accessStatus: 'ativa', subscriptionEndsAt: { not: null } },
    include: { members: { select: { email: true, name: true, role: true } } },
    take: 20000
  });
  const sent = [];
  for (const a of accounts) {
    if (a.members.some((m) => isPlatformAdminEmail(m.email))) continue;
    const acc = computeAccess(a, now);
    if (acc.daysLeft === null || acc.daysLeft === undefined || !STEPS.includes(acc.daysLeft)) continue;
    const owner = a.members.find((m) => m.role === 'owner');
    if (!owner?.email) continue;
    const period = new Date(a.subscriptionEndsAt).toISOString().slice(0, 10);
    const metric = `renewal_notice_${acc.daysLeft}`;
    const done = await prisma.usageCounter.findUnique({ where: { accountId_period_metric: { accountId: a.id, period, metric } } });
    if (done) continue;
    // marca antes de enviar: se o e-mail falhar, não repete o aviso a cada execução
    await prisma.usageCounter.create({ data: { accountId: a.id, period, metric, value: 1 } }).catch(() => {});
    const trial = !a.planId;
    const d = acc.daysLeft;
    const when = d > 1 ? `vence em ${d} dias` : d === 1 ? 'vence amanhã' : d === 0 ? 'vence hoje' : `venceu há ${-d} dias`;
    const link = `${(env.frontendUrl || env.backendPublicUrl || '').replace(/\/$/, '')}/assinatura`;
    const html = mailer.buildActionEmail({
      greeting: `Olá${owner.name ? `, ${owner.name}` : ''}!`,
      intro: d >= 0
        ? `${trial ? 'Seu período de teste' : 'Sua assinatura'} ${when}. Renove para não perder o acesso ao sistema, aos contatos e às campanhas.`
        : `Sua assinatura ${when} e o acesso será bloqueado se o pagamento não for feito. Regularize agora e tudo volta na hora.`,
      buttonText: trial ? 'Escolher um plano' : 'Renovar agora', url: link, footer: 'Se você já pagou, ignore este aviso: a liberação é automática.'
    });
    await mailer.sendSystemEmail({ to: owner.email, subject: `${trial ? 'Seu teste' : 'Sua assinatura'} ${when} — ${env.appName}`, html, accountId: a.id }).then(() => sent.push({ id: a.id, days: d })).catch((e) => console.warn('Aviso de vencimento:', e.message));
  }
  return { sent };
}

function startRenewalReminderJob() {
  cron.schedule('0 9 * * *', () => runNow().catch((e) => console.error('❌ Aviso de vencimento:', e.message)), { timezone: 'America/Sao_Paulo' });
  console.log('✅ Aviso de vencimento por e-mail ativo (9h)');
}

module.exports = { startRenewalReminderJob, runNow, STEPS };
