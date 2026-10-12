// backend/src/services/leadSearch/emailFinder.js
//
// Procura e-mails PÚBLICOS no site da própria empresa (página inicial e de
// contato). Só lê páginas abertas; não entra em redes sociais nem em áreas com login.
const axios = require('axios');
const { assertSafeUrl, htmlToText } = require('../ai/voice/catalogService');

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const JUNK_DOMAINS = /(sentry|wixpress|example|domain\.com|email\.com|seudominio|yourdomain|schema\.org|w3\.org|googleapis|gstatic|cloudflare|godaddy)/i;
const JUNK_FILES = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$/i;
const CONTACT_PATHS = ['', '/contato', '/contact', '/fale-conosco', '/sobre'];
const GENERIC_PREFERRED = /^(contato|comercial|vendas|atendimento|financeiro|sac|info|adm|administrativo)@/i;

function cleanEmail(e) {
  const email = String(e || '').trim().toLowerCase().replace(/[.,;:)>\]]+$/, '');
  if (!email || email.length > 120 || JUNK_FILES.test(email) || JUNK_DOMAINS.test(email.split('@')[1] || '')) return null;
  return email;
}

function extractEmails(html) {
  const found = new Set();
  const decoded = String(html || '').replace(/&#64;|&commat;|\[at\]|\(at\)/gi, '@').replace(/%40/g, '@');
  for (const m of decoded.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(cleanEmail(m[1]));
  for (const m of htmlToText(decoded).matchAll(EMAIL_REGEX)) found.add(cleanEmail(m[0]));
  return [...found].filter(Boolean);
}

/** Entre vários, prefere o do mesmo domínio do site e os genéricos de contato. */
function pickBest(emails, website) {
  if (!emails.length) return null;
  let host = '';
  try { host = new URL(website).hostname.replace(/^www\./, ''); } catch { /* sem site */ }
  const score = (e) => (host && e.endsWith(`@${host}`) ? 2 : 0) + (GENERIC_PREFERRED.test(e) ? 1 : 0);
  return [...emails].sort((a, b) => score(b) - score(a))[0];
}

async function findEmail(website) {
  let base;
  try {
    base = assertSafeUrl(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  } catch {
    return null;
  }
  const all = new Set();
  for (const path of CONTACT_PATHS) {
    try {
      const url = new URL(path || '/', base.origin).toString();
      const { data } = await axios.get(url, {
        timeout: 7000,
        maxContentLength: 1.5 * 1024 * 1024,
        responseType: 'text',
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TurboProspectBot/1.0)', Accept: 'text/html' }
      });
      extractEmails(data).forEach((e) => all.add(e));
      if (all.size >= 3) break;
    } catch {
      // página inexistente ou fora do ar: tenta a próxima
    }
  }
  return pickBest([...all], base.toString());
}

/** Vários sites em paralelo (poucos por vez, para ser gentil com os servidores). */
async function findEmails(items, concurrency = 5) {
  const out = {};
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      out[item.id] = item.website ? await findEmail(item.website).catch(() => null) : null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

module.exports = { findEmail, findEmails, extractEmails, pickBest };
