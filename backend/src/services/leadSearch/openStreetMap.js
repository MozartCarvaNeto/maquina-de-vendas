// backend/src/services/leadSearch/openStreetMap.js
//
// Fonte GRATUITA (sem chave): OpenStreetMap via Nominatim. A cobertura de
// telefone/e-mail varia por cidade (depende de voluntários) — costuma ter menos
// dados que o Google Maps. Política do Nominatim: 1 consulta por segundo e
// identificação do aplicativo (User-Agent).
const axios = require('axios');
const { normalizePhone, isBrazilMobile } = require('./phoneUtils');

async function search({ query, location, limit = 40 }) {
  let data;
  try {
    ({ data } = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: `${query}, ${location}`, format: 'jsonv2', addressdetails: 1, extratags: 1, limit: Math.min(limit, 50), countrycodes: 'br', 'accept-language': 'pt-BR' },
      headers: { 'User-Agent': 'TurboProspect/1.0 (busca de empresas)' },
      timeout: 20000
    }));
  } catch (error) {
    const err = new Error(`OpenStreetMap: ${error.message}`);
    err.status = 502;
    throw err;
  }

  const results = [];
  for (const p of data || []) {
    // Só estabelecimentos (ignora ruas, bairros, cidades).
    if (!['amenity', 'shop', 'office', 'craft', 'healthcare', 'tourism', 'leisure'].includes(p.category)) continue;
    const tags = p.extratags || {};
    const rawPhone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags.mobile;
    const phone = normalizePhone(String(rawPhone || '').split(';')[0]);
    const a = p.address || {};
    const address = [a.road && `${a.road}${a.house_number ? `, ${a.house_number}` : ''}`, a.suburb, a.city || a.town || a.village, a.state].filter(Boolean).join(' - ');
    results.push({
      id: `o:${p.osm_type}${p.osm_id}`,
      name: p.name || p.display_name?.split(',')[0] || '',
      phone,
      whatsappLikely: isBrazilMobile(phone),
      email: tags.email || tags['contact:email'] || null,
      website: tags.website || tags['contact:website'] || null,
      address: address || null,
      mapsUrl: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`,
      source: 'openstreetmap'
    });
  }
  return results.filter((r) => r.name);
}

module.exports = { search };
