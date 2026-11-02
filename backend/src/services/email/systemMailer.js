// backend/src/services/email/systemMailer.js
//
// E-mails do SISTEMA (recuperar senha, avisos). Antes dependiam do e-mail que o
// próprio cliente configurava em Configurações — e um cliente novo não tem nada
// configurado, então "Esqueci minha senha" nunca funcionava para ele.
// Agora: 1º usa o SMTP do sistema (SYSTEM_SMTP_* no .env); se não houver,
// tenta o provedor de e-mail da conta; se nada existir, avisa por erro.
const nodemailer = require('nodemailer');
const env = require('../../config/env');

let transport = null;

function isConfigured() {
  const s = env.systemSmtp;
  return Boolean(s.host && s.user && s.pass);
}

function getTransport() {
  if (!transport) {
    const s = env.systemSmtp;
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port || 587,
      secure: s.port === 465,
      auth: { user: s.user, pass: s.pass }
    });
  }
  return transport;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Modelo de e-mail simples, com botão grande (funciona bem no celular). */
function buildActionEmail({ greeting, intro, buttonText, url, footer }) {
  const safeUrl = escapeHtml(url);
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
    <h2 style="margin:0 0 12px;color:#0f172a;">🚀 ${escapeHtml(env.appName)}</h2>
    <p style="color:#334155;font-size:15px;">${escapeHtml(greeting)}</p>
    <p style="color:#334155;font-size:15px;">${escapeHtml(intro)}</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${safeUrl}" style="background:#0096c7;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:8px;font-weight:bold;display:inline-block;">${escapeHtml(buttonText)}</a>
    </p>
    <p style="color:#64748b;font-size:12px;">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all;">${safeUrl}</span></p>
    <p style="color:#94a3b8;font-size:12px;">${escapeHtml(footer || '')}</p>
  </div></body></html>`;
}

/** Contas dos administradores da plataforma (SUPERADMIN_EMAILS): o e-mail delas serve de remetente do sistema. */
async function getPlatformAdminAccountIds() {
  const emails = env.superAdminEmails || [];
  if (!emails.length) return [];
  const prisma = require('../../config/db');
  const members = await prisma.member.findMany({
    where: { OR: emails.map((e) => ({ email: { equals: e, mode: 'insensitive' } })) },
    select: { accountId: true }
  });
  return [...new Set(members.map((m) => m.accountId))];
}

/**
 * Envia um e-mail do sistema tentando, em ordem:
 *  1) SMTP do sistema (SYSTEM_SMTP_* no .env);
 *  2) e-mail configurado na conta de quem está sendo avisado;
 *  3) e-mail configurado na conta do ADMINISTRADOR da plataforma (Configurações > E-mail dele).
 * Antes só havia 1 e 2: cliente novo não tem e-mail configurado, então "Esqueci minha senha" não chegava nunca.
 * Devolve { via, attempts } com o resultado de cada tentativa (usado também no teste do painel Admin).
 */
async function sendSystemEmailDetailed({ to, subject, html, accountId }) {
  const attempts = [];

  if (isConfigured()) {
    try {
      const s = env.systemSmtp;
      await getTransport().sendMail({ from: s.from || s.user, to, subject, html });
      attempts.push({ via: 'SMTP do sistema', ok: true });
      return { via: 'system', attempts };
    } catch (error) {
      attempts.push({ via: 'SMTP do sistema', ok: false, error: error.message });
    }
  } else {
    attempts.push({ via: 'SMTP do sistema', ok: false, error: 'não configurado (SYSTEM_SMTP_HOST/USER/PASS no .env)' });
  }

  const accountIds = [];
  if (accountId) accountIds.push({ id: accountId, label: 'e-mail da própria conta' });
  try {
    for (const id of await getPlatformAdminAccountIds()) {
      if (id !== accountId) accountIds.push({ id, label: 'e-mail do administrador da plataforma' });
    }
  } catch (error) {
    attempts.push({ via: 'administrador da plataforma', ok: false, error: error.message });
  }

  const { getEmailProvider } = require('./emailProviderFactory');
  for (const target of accountIds) {
    try {
      const provider = await getEmailProvider(target.id);
      await provider.sendEmail({ to, subject, html });
      attempts.push({ via: target.label, ok: true });
      return { via: 'account', attempts };
    } catch (error) {
      attempts.push({ via: target.label, ok: false, error: error.message });
    }
  }

  const err = new Error(
    `Nenhum e-mail do sistema funcionou: ${attempts.map((a) => `${a.via} → ${a.error}`).join(' | ')}`
  );
  err.attempts = attempts;
  throw err;
}

async function sendSystemEmail(args) {
  const { via } = await sendSystemEmailDetailed(args);
  return { via };
}

// Só para testes automatizados.
function _setTransportForTests(fake) {
  transport = fake;
}

module.exports = { sendSystemEmail, sendSystemEmailDetailed, buildActionEmail, isConfigured, escapeHtml, _setTransportForTests };
