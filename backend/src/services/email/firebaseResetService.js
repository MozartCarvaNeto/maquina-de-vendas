// backend/src/services/email/firebaseResetService.js
// Usa o Firebase Authentication SOMENTE como "carteiro" de e-mails de redefinição de senha.
// As contas e senhas continuam no banco (Supabase/Postgres) do sistema.
const crypto = require('crypto');
const env = require('../../config/env');

const BASE = 'https://identitytoolkit.googleapis.com/v1';

function isConfigured() {
  return Boolean(env.firebaseApiKey);
}

async function call(path, body, headers = {}) {
  const res = await fetch(`${BASE}/${path}?key=${encodeURIComponent(env.firebaseApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Firebase HTTP ${res.status}`);
    err.firebaseCode = data?.error?.message || '';
    throw err;
  }
  return data;
}

// Garante que o e-mail exista no Firebase (o Firebase só envia e-mail para contas existentes).
async function ensureUser(email) {
  try {
    await call('accounts:signUp', {
      email,
      password: crypto.randomBytes(24).toString('base64url'),
      returnSecureToken: false
    });
  } catch (err) {
    if (!/EMAIL_EXISTS/.test(err.firebaseCode || '')) throw err;
  }
}

// Pede ao Firebase para enviar o e-mail de redefinição ao usuário.
async function sendPasswordReset(email) {
  const send = () =>
    call('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email }, { 'X-Firebase-Locale': 'pt-BR' });
  try {
    return await send();
  } catch (err) {
    if (/EMAIL_NOT_FOUND/.test(err.firebaseCode || '')) {
      await ensureUser(email);
      return send();
    }
    throw err;
  }
}

// Consome o código do link (uso único, validade controlada pelo Firebase) e devolve o e-mail dono dele.
async function consumeOobCode(oobCode) {
  const data = await call('accounts:resetPassword', {
    oobCode,
    newPassword: crypto.randomBytes(24).toString('base64url')
  });
  return String(data.email || '').toLowerCase();
}

module.exports = { isConfigured, sendPasswordReset, consumeOobCode };
