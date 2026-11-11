// backend/src/services/email/emailTrackingService.js
//
// Abertura, clique e descadastro de e-mail — a parte que, em plataformas
// como Mailchimp/Brevo, aparece como "estatísticas da campanha". Aqui é
// feito com um pixel invisível, redirecionamento de link e uma página de
// descadastro, tudo servido pelo próprio backend.
const crypto = require('crypto');
const prisma = require('../../config/db');
const env = require('../../config/env');

// GIF transparente de 1x1 pixel — o menor arquivo de imagem válido que existe.
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');

function generateTrackingToken() {
  return crypto.randomBytes(16).toString('hex');
}

function trackingBaseUrl() {
  return `${env.backendPublicUrl.replace(/\/$/, '')}/api/email/t`;
}

function buildOpenPixelTag(token) {
  return `<img src="${trackingBaseUrl()}/o/${token}.gif" width="1" height="1" alt="" style="display:none !important;" />`;
}

function buildUnsubscribeUrl(token) {
  return `${trackingBaseUrl()}/u/${token}`;
}

/**
 * Troca cada link http(s) do corpo do e-mail por um link que passa pelo
 * nosso redirecionador de cliques antes de seguir para o destino real.
 * Deixa "mailto:" e âncoras ("#...") em paz.
 */
function rewriteLinksForClickTracking(html, token) {
  return String(html || '').replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, url) => {
    const redirect = `${trackingBaseUrl()}/c/${token}?u=${encodeURIComponent(url)}`;
    return `href=${quote}${redirect}${quote}`;
  });
}

async function findMessageByToken(token) {
  return prisma.emailMessage.findUnique({ where: { trackingToken: token } });
}

async function registerOpen(token) {
  const message = await findMessageByToken(token);
  if (message && !message.openedAt) {
    await prisma.emailMessage.update({ where: { id: message.id }, data: { openedAt: new Date() } });
  }
}

async function registerClick(token) {
  const message = await findMessageByToken(token);
  if (message && !message.clickedAt) {
    await prisma.emailMessage.update({ where: { id: message.id }, data: { clickedAt: new Date() } });
  }
}

/** Marca o lead como "não enviar mais" e registra a supressão — para nunca mais mandar e-mail a ele. */
async function registerUnsubscribe(token) {
  const message = await findMessageByToken(token);
  if (!message) return null;

  await prisma.emailSuppression.upsert({
    where: { userId_email: { userId: message.userId, email: message.toEmail } },
    update: { reason: 'descadastro' },
    create: { userId: message.userId, email: message.toEmail, reason: 'descadastro' }
  });

  // Descadastro de E-MAIL vale só para e-mail: não marca o lead como "não
  // contatar" em tudo (isso bloquearia WhatsApp/ligação sem a pessoa pedir).
  return message;
}

// ---------------------------------------------------------------------
// Descadastro por link assinado — vale para QUALQUER provedor de e-mail
// (SMTP, Resend, SendGrid, Twilio), que não têm rastreio próprio.
// O token carrega conta + e-mail e é assinado (HMAC) com o segredo do
// sistema: não dá para adivinhar o link de outra pessoa.
// ---------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sign(payload) {
  return b64url(crypto.createHmac('sha256', env.jwtSecret).update(`unsub:${payload}`).digest()).slice(0, 32);
}

function createSignedUnsubToken(userId, email) {
  const payload = b64url(JSON.stringify([userId, String(email || '').trim().toLowerCase()]));
  return `${payload}.${sign(payload)}`;
}

function parseSignedUnsubToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const [userId, email] = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!userId || !email) return null;
    return { userId, email };
  } catch (_e) {
    return null;
  }
}

function buildSignedUnsubscribeUrl(userId, email) {
  return `${trackingBaseUrl()}/s/${createSignedUnsubToken(userId, email)}`;
}

async function registerSignedUnsubscribe(token) {
  const data = parseSignedUnsubToken(token);
  if (!data) return null;
  await prisma.emailSuppression.upsert({
    where: { userId_email: { userId: data.userId, email: data.email } },
    update: { reason: 'descadastro' },
    create: { userId: data.userId, email: data.email, reason: 'descadastro' }
  });
  return data;
}

/** Rodapé + cabeçalhos de descadastro para provedores que não os colocam sozinhos. */
function buildUnsubscribeExtras(userId, email) {
  const url = buildSignedUnsubscribeUrl(userId, email);
  return {
    url,
    footerHtml: `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:12px;color:#999;text-align:center;">Não quer mais receber estes e-mails? <a href="${url}" style="color:#999;">Cancelar inscrição</a>.</div>`,
    headers: {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

async function isSuppressed(userId, email) {
  email = String(email || '').trim().toLowerCase();
  const row = await prisma.emailSuppression.findUnique({
    where: { userId_email: { userId, email } }
  });
  return !!row;
}

module.exports = {
  TRANSPARENT_GIF,
  generateTrackingToken,
  buildOpenPixelTag,
  buildUnsubscribeUrl,
  rewriteLinksForClickTracking,
  registerOpen,
  registerClick,
  registerUnsubscribe,
  buildSignedUnsubscribeUrl,
  parseSignedUnsubToken,
  registerSignedUnsubscribe,
  buildUnsubscribeExtras,
  isSuppressed
};