// Testa o serviço de WhatsApp rodando com o driver sem navegador (WHATSAPP_DRIVER=baileys), com dublês.
// Rode com:  node tests/whatsappBaileysDriver.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const updates = [];
const statuses = [];
let connectionsInDb = [];
const created = [];
class FakeBaileys extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; this.destroyed = 0; this.open = false; created.push(this); }
  async initialize() {}
  async destroy() { this.destroyed += 1; this.open = false; }
  async getState() { return this.open ? 'CONNECTED' : 'DISCONNECTED'; }
  async getNumberId(d) { return { user: d, server: 'c.us', _serialized: `${d}@c.us` }; }
  async getContactLidAndPhone() { return []; }
  async sendMessage(chat, content, opts) { this.sent.push({ chat, content, opts }); return { id: 'ok' }; }
}
const stubs = {
  './baileysClient': { BaileysClient: FakeBaileys },
  'whatsapp-web.js': new Proxy({}, { get() { throw new Error('whatsapp-web.js NÃO deveria ser carregado no modo baileys'); } }),
  './patchWwebjs': new Proxy({}, { get() { throw new Error('patch do wwebjs NÃO deveria rodar no modo baileys'); } }),
  qrcode: { toDataURL: async (q) => `data:${q}` },
  '../../config/db': { whatsappConnection: {
    update: async (a) => { updates.push(a); return null; }, findMany: async () => connectionsInDb } },
  '../../config/env': { whatsappDriver: 'baileys', whatsappMinFreeMb: 0, whatsappChromiumArgs: [] },
  './chatMediaService': { MAX_RECEIVE_BYTES: 1 },
  './audioConvertService': {},
  '../accessService': { isAccountBlocked: async () => false },
  '../featureService': { accountHasFeature: async () => true },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const svc = require('../src/services/whatsapp/nativeWhatsappService');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
svc.setStatus = async (id, st) => { statuses.push([id, st]); };
svc.emitStatus = () => {};
svc.emitQr = () => {};

test('conecta pelo driver sem navegador e envia texto e anexo', async () => {
  await svc.initSession({ id: ID(1), userId: 'u' });
  const c = created[0];
  assert.equal(c.opts.clientId, ID(1));
  c.emit('qr', 'QR1'); await tick();
  assert.equal(svc.qrFlags.get(ID(1)), true);
  c.open = true; c.info = { wid: { user: '5511999998888' } };
  c.emit('authenticated'); c.emit('ready'); await tick();
  assert.equal(svc.isReady(ID(1)), true);
  assert.equal(await svc.getStatus(ID(1)), 'conectado');
  assert.ok(updates.some((u) => u.data.status === 'conectado' && u.data.phone === '5511999998888'));

  await svc.sendMessage(ID(1), '(11) 98888-7777', 'olá');
  assert.equal(c.sent[0].chat, '5511988887777@c.us');
  assert.equal(c.sent[0].content, 'olá');

  const arquivo = path.join(require('os').tmpdir(), `teste-${Date.now()}.pdf`);
  fs.writeFileSync(arquivo, 'pdf');
  await svc.sendMessage(ID(1), '11988887777', 'segue', arquivo, { asDocument: true });
  fs.rmSync(arquivo);
  const anexo = c.sent[1].content;
  assert.equal(anexo.mimetype, 'application/pdf');
  assert.equal(Buffer.from(anexo.data, 'base64').toString(), 'pdf');
  assert.equal(c.sent[1].opts.sendMediaAsDocument, true);
});

test('queda de conexão agenda reconexão; logout pede novo QR e apaga credenciais', async () => {
  const dir = svc.sessionDirOf(ID(1));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
  const c = created[0];
  c.emit('disconnected', 'LOGOUT'); await tick(300);
  assert.equal(svc.isReady(ID(1)), false);
  assert.equal(fs.existsSync(dir), false, 'credenciais apagadas no logout');
  assert.ok(statuses.some(([id, st]) => id === ID(1) && st === 'erro'));
  assert.ok(c.destroyed >= 1);
});

test('apagar a conexão não deixa nada na memória', async () => {
  await svc.initSession({ id: ID(2), userId: 'u' });
  await svc.destroySession(ID(2), { permanent: true });
  assert.equal(svc.clients.has(ID(2)), false);
  assert.equal(svc.owners.has(ID(2)), false);
  assert.equal(svc.generations.has(ID(2)), false);
});

test('ao ligar o servidor: só reabre quem tem credenciais; sessão antiga do Chromium vira "desconectado"', async () => {
  const comCreds = ID(3), antiga = ID(4);
  const dir3 = svc.sessionDirOf(comCreds); const dir4 = svc.sessionDirOf(antiga);
  fs.mkdirSync(dir3, { recursive: true }); fs.writeFileSync(path.join(dir3, 'creds.json'), '{}');
  fs.mkdirSync(path.join(dir4, 'Default'), { recursive: true });           // perfil de Chromium, sem creds.json
  connectionsInDb = [{ id: comCreds, userId: 'u', status: 'conectado' }, { id: antiga, userId: 'u', status: 'conectado' }];
  created.length = 0; statuses.length = 0;
  const boot = svc.bootstrapExistingSessions();
  await tick(100);
  const abertos = created.map((c) => c.opts.clientId);
  assert.deepEqual(abertos, [comCreds]);
  created[0].open = true; created[0].emit('authenticated'); created[0].emit('ready');
  await boot;
  assert.ok(statuses.some(([id, st]) => id === antiga && st === 'desconectado'));
  await svc.shutdownAll({ timeoutMs: 500 });
  fs.rmSync(dir3, { recursive: true, force: true }); fs.rmSync(dir4, { recursive: true, force: true });
});
