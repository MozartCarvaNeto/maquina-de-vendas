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

  if (message.leadId) {
    await prisma.lead.update({ where: { id: message.leadId }, data: { optOut: true } }).catch(() => {
      // o lead pode já ter sido removido — não é motivo para falhar o descadastro
    });
  }

  return message;
}

async function isSuppressed(userId, email) {
  const row = await prisma.emailSuppression.findUnique({
    where: { userId_email: { userId, email: String(email || '').toLowerCase() } }
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
  isSuppressed
};