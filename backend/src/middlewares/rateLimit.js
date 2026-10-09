// backend/src/middlewares/rateLimit.js
//
// Proteção contra adivinhação de senha e abuso, SEM depender de pacotes extras.
// Os contadores ficam na memória do servidor (zeram se ele reiniciar) — o que é
// suficiente para um servidor único como o deste projeto.
//
// IMPORTANTE: atrás do Nginx/Caddy, o servidor precisa de "trust proxy" (já
// configurado em server.js) para enxergar o IP REAL da pessoa em req.ip.

/** Limita QUANTAS requisições uma chave (ex.: IP) pode fazer numa janela de tempo. */
function createRateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // chave -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, 60 * 1000);
  timer.unref();

  const middleware = (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: message || 'Muitas tentativas. Aguarde um pouco e tente novamente.',
        code: 'RATE_LIMITED',
        retryAfterSeconds
      });
    }
    next();
  };
  middleware._hits = hits;
  return middleware;
}

/**
 * Conta apenas as FALHAS (senha errada). Depois de "maxFailures" falhas na
 * janela, a chave fica bloqueada até a janela acabar. Acertar a senha zera.
 */
function createFailureLimiter({ windowMs, maxFailures }) {
  const failures = new Map(); // chave -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
  }, 60 * 1000);
  timer.unref();

  return {
    /** @returns {{blocked:boolean, retryAfterSeconds:number}} */
    check(key) {
      const entry = failures.get(key);
      const now = Date.now();
      if (!entry || entry.resetAt <= now || entry.count < maxFailures) {
        return { blocked: false, retryAfterSeconds: 0 };
      }
      return { blocked: true, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    },
    fail(key) {
      const now = Date.now();
      let entry = failures.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        failures.set(key, entry);
      }
      entry.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
    _failures: failures
  };
}

function minutesText(seconds) {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minuto${m === 1 ? '' : 's'}`;
}

module.exports = { createRateLimiter, createFailureLimiter, minutesText };
