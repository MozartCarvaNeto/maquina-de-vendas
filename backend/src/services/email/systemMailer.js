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

async function sendSystemEmail({ to, subject, html, accountId }) {
  if (isConfigured()) {
    const s = env.systemSmtp;
    await getTransport().sendMail({ from: s.from || s.user, to, subject, html });
    return { via: 'system' };
  }
  if (accountId) {
    const { getEmailProvider } = require('./emailProviderFactory');
    const provider = await getEmailProvider(accountId);
    await provider.sendEmail({ to, subject, html });
    return { via: 'account' };
  }
  throw new Error('Nenhum e-mail do sistema configurado (SYSTEM_SMTP_* no .env).');
}

// Só para testes automatizados.
function _setTransportForTests(fake) {
  transport = fake;
}

module.exports = { sendSystemEmail, buildActionEmail, isConfigured, escapeHtml, _setTransportForTests };
