// Testa que apagar/trocar uma sessão de WhatsApp NÃO deixa navegador (Chromium) vivo na memória.
// Rode com:  node tests/whatsappMemory.test.js      (não precisa de internet nem de WhatsApp)
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const cp = require('child_process');

// ---------- dublês ----------
const pkillCalls = [];
let psOutput = '';
let pkillGate = null; // se definido, o pkill só termina quando a função for chamada
cp.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') cb = opts;
  if (cmd === 'ps') return process.nextTick(() => cb(null, psOutput));
  if (cmd === 'pkill') {
    pkillCalls.push(args[args.length - 1]);
    if (pkillGate) { pkillGate.push(() => cb(null)); return; }
  }
  return process.nextTick(() => cb(null));
};

const clientsCreated = [];
class FakeClient {
  constructor(opts) {
    this.opts = opts; this.destroyed = 0; this.killed = 0; this.handlers = {};
    this.pupBrowser = { process: () => ({ killed: false, kill: () => { this.killed += 1; } }) };
    this.initDone = new Promise((res, rej) => { this.finishInit = res; this.failInit = rej; });
    clientsCreated.push(this);
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  initialize() { return this.initDone; }
  async destroy() { this.destroyed += 1; }
}
const stubs = {
  'whatsapp-web.js': { Client: FakeClient, LocalAuth: class { constructor(o) { this.o = o; } }, MessageMedia: class {} },
  './patchWwebjs': {},
  qrcode: { toDataURL: async () => 'data:' },
  '../../config/db': { whatsappConnection: { update: async () => null, findMany: async () => [] } },
  '../../config/env': { whatsappWebVersion: null, whatsappMinFreeMb: 400, whatsappChromiumArgs: ['--teste-extra'] },
  './chatMediaService': { MAX_RECEIVE_BYTES: 1 },
  './audioConvertService': {},
  '../accessService': { isAccountBlocked: async () => false },
  '../featureService': { accountHasFeature: async () => true },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const svc = require('../src/services/whatsapp/nativeWhatsappService');
const guard = require('../src/services/whatsapp/chromiumGuard');
const tick = () => new Promise((r) => setTimeout(r, 20));
const reset = () => { pkillCalls.length = 0; clientsCreated.length = 0; pkillGate = null; psOutput = ''; };
const ID = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;

test('apagar a conexão ENQUANTO o navegador ainda abre: ele é fechado quando terminar de abrir', async () => {
  reset();
  await svc.initSession({ id: ID(1), userId: 'u', forceNew: false });
  assert.equal(clientsCreated.length, 1);
  assert.ok(clientsCreated[0].opts.puppeteer.args.includes('--teste-extra'), 'args extras do .env chegam ao Chromium');
  await svc.destroySession(ID(1), { permanent: true });       // usuário apaga no meio da abertura
  assert.equal(svc.clients.has(ID(1)), false);
  clientsCreated[0].finishInit();                              // o navegador conclui a abertura "sozinho"
  await tick(); await tick();
  assert.ok(clientsCreated[0].destroyed >= 2, 'destroy() chamado de novo no cliente velho');
  assert.ok(clientsCreated[0].killed >= 1, 'processo do navegador morto à força');
  assert.equal(svc.owners.has(ID(1)), false, 'nada da sessão apagada fica nos mapas do sistema');
  assert.equal(svc.generations.has(ID(1)), false);
  assert.equal(svc.initializing.has(ID(1)), false);
});

test('abertura que FALHA depois de a conexão ser apagada também fecha o navegador', async () => {
  reset();
  await svc.initSession({ id: ID(2), userId: 'u' });
  await svc.destroySession(ID(2), { permanent: true });
  clientsCreated[0].failInit(new Error('Waiting failed: 30000ms exceeded'));
  await tick(); await tick();
  assert.ok(clientsCreated[0].killed >= 1);
});

test('apagar ANTES de o navegador ser criado: nenhuma sessão fantasma é aberta', async () => {
  reset();
  const gate = [];
  pkillGate = gate;                                            // segura o início da abertura (no pkill preventivo)
  const abertura = svc.initSession({ id: ID(3), userId: 'u' });
  await tick();
  pkillGate = null;
  await svc.destroySession(ID(3), { permanent: true });        // usuário apaga aqui
  gate.forEach((liberar) => liberar());                        // a abertura retoma...
  const r = await abertura;
  assert.equal(r, null, 'abertura desiste');
  assert.equal(clientsCreated.length, 0, 'nenhum Client/Chromium criado');
  assert.equal(svc.initializing.has(ID(3)), false);
  assert.equal(await svc.initSession({ id: ID(3), userId: 'u' }), null, 'tentativa seguinte também é recusada');
});

test('reconectar (não permanente) continua funcionando para o mesmo id', async () => {
  reset();
  await svc.initSession({ id: ID(4), userId: 'u' });
  await svc.destroySession(ID(4));                              // reconectar: NÃO é exclusão
  const c = await svc.initSession({ id: ID(4), userId: 'u', forceNew: true });
  assert.ok(c, 'nova sessão abre normalmente');
  assert.equal(clientsCreated.length, 2);
  await svc.destroySession(ID(4), { permanent: true });
});

test('limpador de órfãos: mata só o Chromium que nenhuma sessão ativa reconhece', async () => {
  reset();
  const raiz = svc.getSessionsRoot();
  await svc.initSession({ id: ID(5), userId: 'u' });            // sessão ativa conhecida
  pkillCalls.length = 0;
  psOutput = [
    `  100 409600 /usr/bin/chromium --no-sandbox --user-data-dir=${raiz}/session-${ID(5)}`,   // ativa: não mexe
    `  101 307200 /usr/bin/chromium --type=renderer --user-data-dir=${raiz}/session-${ID(6)}`, // órfã (sessão apagada)
    `  102 204800 /usr/bin/chromium --user-data-dir=${raiz}/session-${ID(6)}`,                 // mesma órfã
    `  103 512000 /usr/bin/chromium --user-data-dir=/home/outro-app/sessions/session-${ID(7)}`,// de outro programa: ignora
    `  104 102400 node server.js`,
  ].join('\n');
  const r = await svc.reapOrphanBrowsers();
  assert.deepEqual(r, { processes: 3, orphans: 1 });
  assert.deepEqual(pkillCalls, [`session-${ID(6)}`]);
  await svc.destroySession(ID(5), { permanent: true });
});

test('estatística de memória por sessão e leitura do /proc/meminfo', () => {
  const lista = guard.parsePs(`  10 2048000 chromium --user-data-dir=/x/sessions/session-${ID(8)}\n`, '/x/sessions');
  assert.deepEqual(lista, [{ pid: 10, rssMb: 2000, sessionId: ID(8) }]);
  assert.equal(guard.memoryAvailableMb(() => 'MemTotal: 3900000 kB\nMemAvailable:    819200 kB\n'), 800);
  assert.equal(guard.memoryAvailableMb(() => { throw new Error('sem /proc'); }), null);
});

test('proteção de capacidade: recusa NOVA conexão sem memória, aceita com memória ou sem medição', () => {
  const real = guard.memoryAvailableMb;
  try {
    guard.memoryAvailableMb = () => 150;
    const r = svc.checkCapacity();
    assert.equal(r.ok, false);
    assert.match(r.message, /150 MB livres; mínimo 400 MB/);
    guard.memoryAvailableMb = () => 900;
    assert.equal(svc.checkCapacity().ok, true);
    guard.memoryAvailableMb = () => null;
    assert.equal(svc.checkCapacity().ok, true);
    stubs['../../config/env'].whatsappMinFreeMb = 0;               // 0 desliga a proteção
    guard.memoryAvailableMb = () => 10;
    assert.equal(svc.checkCapacity().ok, true);
  } finally { guard.memoryAvailableMb = real; stubs['../../config/env'].whatsappMinFreeMb = 400; }
});
