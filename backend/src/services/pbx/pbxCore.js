// backend/src/services/pbx/pbxCore.js
// Peças comuns do PBX: código curto da conta, senha dos avisos do Asterisk, configurações e nomes.
const crypto = require('crypto');
const path = require('path');
const env = require('../../config/env');
const prisma = require('../../config/db');
const { readStoredCredentials, persistCredentials } = require('../settingsHelpers');

/** Código de 4 letras/números da conta (o mesmo prefixo dos ramais). Separa contas dentro do mesmo Asterisk. */
function tagFor(userId) {
  return crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 4);
}

function hookToken() {
  const secret = env.pbxHookSecret || process.env.JWT_SECRET || 'turbo';
  return crypto.createHmac('sha256', secret).update('pbx-hook-v1').digest('hex').slice(0, 32);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Endereço que o Asterisk (no mesmo servidor) usa para avisar o sistema. */
function localHookBase() {
  return require('./asteriskHost').hookBase();
}

function slug(name, fallback = 'x') {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || fallback;
}

const short = (id) => String(id || '').replace(/-/g, '').slice(0, 8);

const queueName = (tag, q) => `q${tag}_${slug(q.name, short(q.id))}_${short(q.id).slice(0, 4)}`;
const ivrContext = (tag, ivr) => `turbo-ivr-${tag}-${short(ivr.id)}`;
const routeContext = (tag, r) => `turbo-rt-${tag}-${short(r.id)}`;

function soundPath(tag, audioId) {
  return path.posix.join(require('./asteriskHost').dirs().sounds, tag, audioId); // sem extensão: o Asterisk escolhe .wav
}

const DEFAULT_SETTINGS = { recordInbound: 'true', recordOutbound: 'true', aiHandoffQueueId: '', aiInboundAgentId: '', aiInboundGreeting: '', sttLanguage: 'pt-BR', sttProvider: 'auto' };

async function getPbxSettings(userId) {
  const stored = await readStoredCredentials(userId, 'pbx', 'settings').catch(() => ({}));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function savePbxSettings(userId, incoming) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (incoming[k] !== undefined) clean[k] = String(incoming[k] ?? '');
  }
  const toDelete = Object.keys(clean).filter((k) => clean[k] === '');
  for (const k of toDelete) delete clean[k];
  await persistCredentials(userId, 'pbx', 'settings', clean, toDelete, { exclusive: false });
  return getPbxSettings(userId);
}

/** Horário comercial: {enabled, days:{mon:[["09:00","18:00"]], ...}} -> trechos do GotoIfTime. */
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function hoursToRanges(hours) {
  if (!hours || !hours.enabled) return [];
  const out = [];
  for (const d of DAY_KEYS) {
    for (const r of hours.days?.[d] || []) {
      if (/^\d{2}:\d{2}$/.test(r?.[0]) && /^\d{2}:\d{2}$/.test(r?.[1])) out.push({ range: `${r[0]}-${r[1]}`, day: d });
    }
  }
  return out;
}

function cleanDest(d) {
  if (!d || typeof d !== 'object') return null;
  const type = String(d.type || '');
  if (!['queue', 'ivr', 'extension', 'number', 'voicemail', 'conference', 'ai', 'hangup'].includes(type)) return null;
  const out = { type };
  if (d.id) out.id = String(d.id).slice(0, 80);
  if (d.value) out.value = String(d.value).replace(/[^0-9a-zA-Z+_-]/g, '').slice(0, 40);
  return out;
}

module.exports = {
  tagFor,
  hookToken,
  safeEqual,
  localHookBase,
  slug,
  short,
  queueName,
  ivrContext,
  routeContext,
  soundPath,
  getPbxSettings,
  savePbxSettings,
  hoursToRanges,
  cleanDest,
  DAY_KEYS,
  prisma
};
