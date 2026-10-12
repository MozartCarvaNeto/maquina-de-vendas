// backend/src/services/leadSearchService.js
const prisma = require('../config/db');
const { encrypt, decrypt } = require('./crypto/settingsCrypto');
const google = require('./leadSearch/googlePlaces');
const osm = require('./leadSearch/openStreetMap');
const { phoneKey } = require('./leadSearch/phoneUtils');

const CATEGORY = 'leadsearch';
const PROVIDER = 'google_places';

async function getGoogleKey(userId) {
  const row = await prisma.setting.findFirst({ where: { userId, category: CATEGORY, provider: PROVIDER, key: 'apiKey', isActive: true } });
  return row ? decrypt(row.value) : null;
}

async function saveGoogleKey(userId, apiKey) {
  await prisma.setting.upsert({
    where: { userId_category_provider_key: { userId, category: CATEGORY, provider: PROVIDER, key: 'apiKey' } },
    update: { value: encrypt(String(apiKey)), isActive: true },
    create: { userId, category: CATEGORY, provider: PROVIDER, key: 'apiKey', value: encrypt(String(apiKey)), isActive: true }
  });
}

async function removeGoogleKey(userId) {
  await prisma.setting.deleteMany({ where: { userId, category: CATEGORY, provider: PROVIDER } });
}

/** Marca quem já está na base (pelo telefone) e remove repetidos dentro da própria busca. */
async function markDuplicates(userId, results) {
  const keys = new Set();
  const unique = [];
  for (const r of results) {
    const k = phoneKey(r.phone) || `n:${r.name.toLowerCase()}`;
    if (keys.has(k)) continue;
    keys.add(k);
    unique.push(r);
  }
  const phones = unique.map((r) => phoneKey(r.phone)).filter(Boolean);
  const existing = phones.length
    ? await prisma.lead.findMany({ where: { userId, OR: phones.map((p) => ({ phone: { endsWith: p } })) }, select: { phone: true } })
    : [];
  const have = new Set(existing.map((l) => phoneKey(l.phone)));
  return unique.map((r) => ({ ...r, alreadyInBase: Boolean(phoneKey(r.phone) && have.has(phoneKey(r.phone))) }));
}

async function search({ userId, source, query, location, limit }) {
  let results;
  if (source === 'google') {
    const apiKey = await getGoogleKey(userId);
    if (!apiKey) {
      const err = new Error('Cadastre sua chave do Google Maps em Configurações › Busca de empresas, ou use a fonte gratuita (OpenStreetMap).');
      err.status = 400;
      throw err;
    }
    results = await google.search({ apiKey, query, location, limit });
  } else {
    results = await osm.search({ query, location, limit });
  }
  return markDuplicates(userId, results);
}

module.exports = { search, getGoogleKey, saveGoogleKey, removeGoogleKey, markDuplicates };
