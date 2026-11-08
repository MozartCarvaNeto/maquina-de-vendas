// backend/src/services/smsgw/smsWebhook.js
// Avisa o sistema do cliente (API) quando o SMS muda de situação: enviado, entregue, não entregue, falhou, resposta recebida.
// Cada aviso é um POST em JSON com a assinatura HMAC no cabeçalho X-Turbo-Signature: sha256=<hex> (segredo = o da chave).
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const prisma = require('../../config/db');

const RETRY_MS = [10000, 60000, 300000, 1800000, 7200000];

function webhookSecret(ownerId) {
  const base = process.env.JWT_SECRET || 'turbo';
  return crypto.createHmac('sha256', base).update(`smswh:${ownerId}`).digest('hex').slice(0, 40);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/** Só aceita endereços públicos (evita usar o sistema para acessar a rede interna). */
async function validateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (_) {
    throw Object.assign(new Error('Endereço do webhook inválido.'), { status: 400 });
  }
  if (!['https:', 'http:'].includes(u.protocol)) throw Object.assign(new Error('O webhook precisa começar com https://'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Não coloque usuário/senha no endereço do webhook.'), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw Object.assign(new Error('Endereço interno não é permitido.'), { status: 400 });
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error('Não encontrei esse endereço na internet.'), { status: 400 });
  if (addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error('Endereço interno não é permitido.'), { status: 400 });
  return u.toString();
}

async function post(url, ownerId, payload) {
  await validateUrl(url);
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', webhookSecret(ownerId)).update(body).digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'TurboProspect-Webhook/1', 'X-Turbo-Signature': `sha256=${sig}`, 'X-Turbo-Event': payload.event },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000)
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
}

function deliver(url, ownerId, payload, attempt = 0) {
  post(url, ownerId, payload).catch((e) => {
    if (attempt >= RETRY_MS.length) {
      console.warn(`⚠️ Webhook de SMS desistiu (${url}): ${e.message}`);
      return;
    }
    setTimeout(() => deliver(url, ownerId, payload, attempt + 1), RETRY_MS[attempt]).unref();
  });
}

function present(msg, extra = {}) {
  return {
    event: msg.direction === 'in' ? 'sms.received' : 'sms.status',
    id: msg.id,
    status: msg.status,
    to: msg.toAddr,
    from: msg.fromAddr,
    parts: msg.parts,
    clientRef: msg.clientRef || null,
    error: msg.errorMessage || null,
    body: msg.direction === 'in' ? msg.body : undefined,
    at: new Date().toISOString(),
    ...extra
  };
}

/** Chamado a cada mudança de situação. Nunca lança erro (o envio de SMS não pode depender disso). */
async function notify(msg) {
  try {
    if (msg.direction === 'in') {
      const keys = await prisma.smsApiKey.findMany({ where: { userId: msg.userId, active: true } });
      const sent = new Set();
      for (const k of keys) {
        if (k.webhookUrl && !sent.has(k.webhookUrl)) {
          sent.add(k.webhookUrl);
          deliver(k.webhookUrl, k.id, present(msg));
        }
      }
      return;
    }
    let url = msg.callbackUrl || null;
    let ownerId = msg.apiKeyId || `acct:${msg.userId}`;
    if (!url && msg.apiKeyId) {
      const key = await prisma.smsApiKey.findFirst({ where: { id: msg.apiKeyId } });
      url = key?.webhookUrl || null;
    }
    if (url) deliver(url, ownerId, present(msg));
  } catch (e) {
    console.warn('Webhook de SMS:', e.message);
  }
}

module.exports = { notify, validateUrl, webhookSecret, isPrivateIp, _post: post };
