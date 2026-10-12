// backend/src/services/leadSearch/googlePlaces.js
//
// Busca de empresas pelo Google Places API (New) — fonte oficial do Google Maps.
// Usa a CHAVE DO PRÓPRIO CLIENTE (Configurações). Telefone e site entram na
// faixa "Enterprise" de preço do Google; o cliente tem crédito mensal grátis.
const axios = require('axios');
const { normalizePhone, isBrazilMobile } = require('./phoneUtils');

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.businessStatus',
  'nextPageToken'
].join(',');

async function search({ apiKey, query, location, limit = 40 }) {
  const results = [];
  let pageToken;
  const textQuery = `${query} em ${location}`;

  while (results.length < limit) {
    let data;
    try {
      ({ data } = await axios.post(
        ENDPOINT,
        { textQuery, languageCode: 'pt-BR', regionCode: 'BR', pageSize: Math.min(20, limit - results.length), ...(pageToken ? { pageToken } : {}) },
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS, 'Content-Type': 'application/json' }, timeout: 20000 }
      ));
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      const err = new Error(`Google Maps: ${msg}`);
      err.status = error.response?.status === 403 || error.response?.status === 400 ? 400 : 502;
      throw err;
    }

    for (const p of data.places || []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const phone = normalizePhone(p.internationalPhoneNumber || p.nationalPhoneNumber);
      results.push({
        id: `g:${p.id}`,
        name: p.displayName?.text || '',
        phone,
        whatsappLikely: isBrazilMobile(phone),
        email: null,
        website: p.websiteUri || null,
        address: p.formattedAddress || null,
        mapsUrl: p.googleMapsUri || null,
        source: 'google_maps'
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    // O token de página leva um instante para ficar válido.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results.slice(0, limit);
}

module.exports = { search };
