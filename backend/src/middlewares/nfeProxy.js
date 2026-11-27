// backend/src/middlewares/nfeProxy.js
//
// Publica o emissor de NF-e (Python, em 127.0.0.1) em  /nfe-app  usando o LOGIN DO TURBO PROSPECT.
// Fluxo: a aba "Notas Fiscais" pede um ticket (POST /api/nfe/session, autenticado) -> o navegador abre
// /nfe-app/entrar?t=... -> aqui o ticket vira um cookie assinado (só vale para /nfe-app) -> cada requisição
// confere de novo usuário, conta e plano de NF-e e repassa ao emissor com cabeçalhos ASSINADOS.
// O emissor não tem login próprio e só aceita requisições assinadas.
const http = require('http');
const env = require('../config/env');
const prisma = require('../config/db');
const { checkMemberAccess, isPlatformAdminEmail } = require('../services/accessService');
const nfe = require('../services/nfe/nfeService');
const bridge = require('../services/nfe/nfeBridge');

const COOKIE = 'nfe_gate';
const GATE_TTL = 8 * 3600;
const usedTickets = new Map(); // jti -> exp (uso único)
const ctxCache = new Map(); // "conta:membro" -> { at, ctx }

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function page(res, status, title, text) {
  res.status(status).type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#223">` +
      `<h2>${title}</h2><p>${text}</p><p><a href="/notas-fiscais" target="_top">Abrir Notas Fiscais</a></p></body>`
  );
}

/** Quem é, se pode e com que limite. Cache curto para não bater no banco a cada arquivo/imagem. */
async function loadContext(accountId, memberId) {
  const key = `${accountId}:${memberId}`;
  const hit = ctxCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.ctx;

  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { account: true } });
  let ctx;
  if (!member || member.accountId !== accountId || member.status !== 'ativo') {
    ctx = { ok: false, code: 401, message: 'Sessão inválida. Entre novamente no Turbo Prospect.' };
  } else if (!['owner', 'admin'].includes(member.role)) {
    ctx = { ok: false, code: 403, message: 'Só o proprietário ou administradores da conta acessam as Notas Fiscais.' };
  } else {
    const access = checkMemberAccess(member, member.account);
    if (!access.allowed) {
      ctx = { ok: false, code: 403, message: access.message || 'Acesso da conta suspenso.' };
    } else {
      const isAdmin = isPlatformAdminEmail(member.email);
      const state = await nfe.getState(accountId, { isPlatformAdmin: isAdmin });
      if (state.status === 'sem_plano') {
        ctx = { ok: false, code: 403, message: 'Sua conta ainda não tem um plano de NF-e. Contrate em Notas Fiscais.' };
      } else {
        ctx = {
          ok: true,
          accountId,
          userEmail: member.email,
          role: member.role,
          limit: state.limit,
          storageMb: state.storageMb,
          readOnly: state.status === 'vencida'
        };
      }
    }
  }
  ctxCache.set(key, { at: Date.now(), ctx });
  if (ctxCache.size > 500) ctxCache.clear();
  return ctx;
}

function clientCookieForPython(rawCookie) {
  // o emissor só precisa do próprio cookie de sessão (CSRF); o resto (inclusive nfe_gate) nunca chega a ele
  const c = parseCookies(rawCookie);
  return c.nfe_session ? `nfe_session=${encodeURIComponent(c.nfe_session)}` : '';
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

module.exports = async function nfeProxy(req, res) {
  try {
    if (!env.nfe.secret) {
      return page(res, 503, 'Emissor de NF-e desligado', 'O servidor ainda não foi configurado para o emissor (falta NFE_INTERNAL_SECRET). Fale com o administrador.');
    }

    // 1) entrada com ticket -> cookie da aba
    if (req.path === '/entrar') {
      const t = bridge.verifyToken('t', String(req.query.t || ''));
      const now = Math.floor(Date.now() / 1000);
      for (const [j, exp] of usedTickets) if (exp < now) usedTickets.delete(j);
      if (!t || usedTickets.has(t.j)) return page(res, 401, 'Link expirado', 'Abra as Notas Fiscais de novo pelo menu do Turbo Prospect.');
      usedTickets.set(t.j, t.exp);
      const gate = bridge.signToken('g', { a: t.a, m: t.m }, GATE_TTL);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(gate)}; Path=${env.nfe.prefix}; HttpOnly; SameSite=Lax; Max-Age=${GATE_TTL}${secure ? '; Secure' : ''}`);
      return res.redirect(`${env.nfe.prefix}/`);
    }

    // 2) cookie da aba
    const gate = bridge.verifyToken('g', parseCookies(req.headers.cookie)[COOKIE]);
    if (!gate) return page(res, 401, 'Sessão das Notas Fiscais expirada', 'Volte ao Turbo Prospect e abra a aba Notas Fiscais novamente.');
    const ctx = await loadContext(gate.a, gate.m);
    if (!ctx.ok) return page(res, ctx.code, 'Notas Fiscais indisponível', ctx.message);

    // 3) repassa ao emissor
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP.has(key) || key.startsWith('x-turbo-') || key === 'cookie' || key === 'authorization' || key.startsWith('x-forwarded-')) continue;
      headers[key] = v;
    }
    const cookie = clientCookieForPython(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    headers['x-forwarded-proto'] = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-prefix'] = env.nfe.prefix;
    headers['x-forwarded-for'] = req.ip || '';
    Object.assign(headers, bridge.signHeaders(ctx));

    const target = new URL(env.nfe.url);
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers, timeout: 190000 },
      (up) => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      }
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err) => {
      console.error('NF-e: emissor não respondeu:', err.message);
      if (!res.headersSent) page(res, 502, 'Emissor de NF-e fora do ar', 'O serviço de notas fiscais não está respondendo. Tente de novo em instantes; se persistir, avise o suporte.');
      else res.end();
    });
    req.pipe(upstream);
  } catch (err) {
    console.error('NF-e proxy:', err);
    if (!res.headersSent) page(res, 500, 'Erro', 'Não foi possível abrir as Notas Fiscais agora.');
  }
};
