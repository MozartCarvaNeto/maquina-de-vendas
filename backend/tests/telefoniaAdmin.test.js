// Garante que a CONFIGURAÇÃO da telefonia é só do superadmin e que "agir em nome do cliente" só funciona para ele.
// Rode com:  node tests/telefoniaAdmin.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === '../config/db') return { account: { findUnique: async ({ where }) => (where.id === 'cli1' ? { id: 'cli1' } : null) } };
  return origLoad.call(this, req, ...rest);
};
const actAs = require('../src/middlewares/actAsAccount');
Module._load = origLoad;

const run = async (req) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; let next = false; await actAs(req, res, () => { next = true; }); return { res, next }; };

test('assinante não consegue agir em nome de outra conta', async () => {
  const req = { query: { accountId: 'cli1' }, headers: {}, isPlatformAdmin: false, userId: 'eu' };
  const { next } = await run(req);
  assert.equal(next, true);
  assert.equal(req.userId, 'eu');
});
test('superadmin age em nome do cliente; conta inexistente dá 404', async () => {
  const ok = { query: {}, headers: { 'x-act-as-account': 'cli1' }, isPlatformAdmin: true, userId: 'adm' };
  await run(ok);
  assert.equal(ok.userId, 'cli1');
  const ruim = { query: { accountId: 'nao' }, headers: {}, isPlatformAdmin: true, userId: 'adm' };
  const r = await run(ruim);
  assert.equal(r.res.code, 404);
  assert.equal(r.next, false);
});
test('rotas de configuração do PBX exigem superadmin', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/pbx.routes.js'), 'utf8');
  const config = [/'\/settings'/, /'\/audios'/, /'\/audios\/tts'/, /'\/audios\/:id'/, /'\/ivrs/, /'\/queues/, /'\/routes/, /'\/apply'/];
  for (const line of src.split('\n').filter((l) => /^router\.(post|put|delete)\(/.test(l))) {
    if (config.some((re) => re.test(line))) assert.match(line, /requirePlatformAdmin/, line);
  }
  assert.match(src, /router\.use\(actAsAccount\)/);
});
