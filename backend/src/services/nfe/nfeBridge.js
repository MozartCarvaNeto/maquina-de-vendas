// backend/src/services/nfe/nfeBridge.js
//
// Ponte com o emissor de NF-e (Python): assinatura dos cabeçalhos que dizem ao emissor QUEM está logado,
// e tokens curtos (ticket de entrada / cookie da aba) assinados com o mesmo segredo.
const crypto = require('crypto');
const http = require('http');
const env = require('../../config/env');

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

/** Cabeçalhos assinados (o emissor confere com o mesmo NFE_INTERNAL_SECRET; ver nfe-emissor/app/tenant.py). */
function signHeaders({ accountId, userEmail, role, limit, readOnly }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const lim = limit === null || limit === undefined ? '' : String(limit);
  const ro = readOnly ? '1' : '0';
  const body = [accountId, userEmail || '', role || '', lim, ro, ts].join('|');
  return {
    'X-Turbo-Account': accountId,
    'X-Turbo-User': userEmail || '',
    'X-Turbo-Role': role || '',
    'X-Turbo-Limit': lim,
    'X-Turbo-ReadOnly': ro,
    'X-Turbo-Ts': ts,
    'X-Turbo-Sig': hmac(env.nfe.secret, body)
  };
}

/** Token assinado: kind 't' = ticket de entrada (2 min, uso único), 'g' = cookie da aba (8 h). */
function signToken(kind, payload, ttlSeconds) {
  const data = b64(JSON.stringify({ ...payload, k: kind, exp: Math.floor(Date.now() / 1000) + ttlSeconds, j: crypto.randomBytes(8).toString('hex') }));
  return `${data}.${hmac(`${env.nfe.secret}:token`, data)}`;
}

function verifyToken(kind, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = hmac(`${env.nfe.secret}:token`, data);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.k !== kind || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** GET simples no emissor (JSON). Devolve null se o emissor estiver fora do ar. */
function pyGetJson(path, ctx, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const u = new URL(env.nfe.url + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: signHeaders(ctx), timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? JSON.parse(raw) : null); } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

module.exports = { signHeaders, signToken, verifyToken, pyGetJson };
