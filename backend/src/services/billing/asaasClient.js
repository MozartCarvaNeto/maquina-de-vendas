// backend/src/services/billing/asaasClient.js
//
// Cliente mínimo da API do Asaas (https://docs.asaas.com). Usa o fetch nativo
// do Node 18+. Em "sandbox" nada é cobrado de verdade — use para testar.
const env = require('../../config/env');

function isEnabled() {
  return Boolean(env.asaas.apiKey);
}

function baseUrl() {
  return env.asaas.env === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
}

async function request(method, path, body) {
  if (!isEnabled()) {
    const err = new Error('Cobrança automática não configurada (ASAAS_API_KEY ausente).');
    err.status = 503;
    throw err;
  }
  const res = await globalThis.fetch(baseUrl() + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: env.asaas.apiKey,
      'User-Agent': 'MaquinaDeVendas/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.errors?.[0]?.description || `O Asaas respondeu com erro ${res.status}.`);
    err.status = 502;
    err.providerStatus = res.status;
    throw err;
  }
  return data;
}

const createCustomer = (payload) => request('POST', '/customers', payload);
const createSubscription = (payload) => request('POST', '/subscriptions', payload);
const deleteSubscription = (id) => request('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
const listSubscriptionPayments = (id) => request('GET', `/subscriptions/${encodeURIComponent(id)}/payments`);

module.exports = { isEnabled, baseUrl, createCustomer, createSubscription, deleteSubscription, listSubscriptionPayments };
