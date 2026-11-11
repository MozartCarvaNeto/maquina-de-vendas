// backend/src/services/email/passwordResetService.js
// Link de redefinição de senha: gera, envia pelo e-mail do sistema e avisa o administrador da plataforma.
const crypto = require('crypto');
const prisma = require('../../config/db');
const env = require('../../config/env');
const { sendSystemEmailDetailed, buildActionEmail, escapeHtml } = require('./systemMailer');

const TOKEN_MINUTES = 60;
const recentNotice = new Map(); // memberId -> hora do último aviso ao admin (evita enxurrada de e-mails)
const NOTICE_GAP_MS = 10 * 60 * 1000;

/** Gera o link (válido por 1 hora) e grava só o hash do código no banco. */
async function issueLink(member, minutes = TOKEN_MINUTES) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  await prisma.member.update({
    where: { id: member.id },
    data: { resetToken: hashedToken, resetTokenExpiresAt: new Date(Date.now() + minutes * 60 * 1000) }
  });
  return `${String(env.frontendUrl || '').replace(/\/$/, '')}/redefinir-senha?token=${rawToken}`;
}

/** Envia o link ao próprio usuário. Nunca lança erro: devolve {ok, via, error, attempts}. */
async function sendLink(member, url, { byAdmin = false } = {}) {
  try {
    const r = await sendSystemEmailDetailed({
      to: member.email,
      accountId: member.accountId,
      subject: `Redefinição de senha — ${env.appName}`,
      html: buildActionEmail({
        greeting: `Olá, ${member.name}.`,
        intro: byAdmin
          ? 'A equipe enviou este link para você criar uma nova senha. Ele vale por 1 hora.'
          : 'Recebemos um pedido para criar uma nova senha. O link vale por 1 hora.',
        buttonText: 'Criar nova senha',
        url,
        footer: 'Se você não pediu isso, ignore este e-mail: sua senha continua a mesma.'
      })
    });
    return { ok: true, via: r.via, attempts: r.attempts };
  } catch (e) {
    return { ok: false, error: e.message, attempts: e.attempts || [] };
  }
}

/** E-mails dos administradores da plataforma (SUPERADMIN_EMAILS que tenham conta). */
async function adminEmails() {
  const list = (env.superAdminEmails || []).filter(Boolean);
  if (!list.length) return [];
  const rows = await prisma.member.findMany({
    where: { OR: list.map((e) => ({ email: { equals: e, mode: 'insensitive' } })) },
    select: { email: true, accountId: true }
  });
  return rows.length ? rows : list.map((email) => ({ email, accountId: null }));
}

/**
 * Avisa o administrador que alguém pediu a redefinição.
 * delivery: {ok, via, error}. Se o envio ao cliente falhou, o e-mail ao admin leva o link pronto para repassar.
 */
async function notifyAdmins(member, delivery, { ip = '', url = '' } = {}) {
  try {
    const last = recentNotice.get(member.id) || 0;
    if (Date.now() - last < NOTICE_GAP_MS) return { skipped: true };
    recentNotice.set(member.id, Date.now());
    const admins = await adminEmails();
    const when = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const status = delivery.ok ? 'O link foi enviado ao usuário automaticamente.' : `O e-mail ao usuário NÃO foi enviado (${delivery.error || 'erro desconhecido'}). Envie o link a ele por outro canal ou gere uma senha temporária no painel.`;
    for (const a of admins) {
      if (a.email.toLowerCase() === String(member.email).toLowerCase()) continue;
      const intro = `${member.name} (${member.email}) pediu para redefinir a senha em ${when}${ip ? `, pelo IP ${ip}` : ''}. ${status}`;
      await sendSystemEmailDetailed({
        to: a.email,
        accountId: a.accountId || undefined,
        subject: `Pedido de redefinição de senha — ${member.email}`,
        html: buildActionEmail({
          greeting: 'Aviso para o administrador',
          intro,
          buttonText: delivery.ok || !url ? 'Abrir o painel' : 'Link para repassar ao usuário',
          url: delivery.ok || !url ? `${String(env.frontendUrl || '').replace(/\/$/, '')}/admin` : url,
          footer: 'Você recebe este aviso a cada pedido de redefinição (no máximo 1 a cada 10 minutos por usuário). Não encaminhe o link a ninguém que não seja o dono da conta.'
        })
      }).catch((e) => console.warn('Aviso ao administrador (redefinição de senha):', e.message));
    }
    return { notified: admins.length };
  } catch (e) {
    console.warn('Aviso ao administrador (redefinição de senha):', e.message);
    return { error: e.message };
  }
}

module.exports = { issueLink, sendLink, notifyAdmins, adminEmails, escapeHtml };
