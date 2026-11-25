// Testa o driver sem navegador (Baileys) com uma biblioteca de mentira: não precisa de internet nem de WhatsApp.
// Rode com:  node tests/baileysClient.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaileysClient } = require('../src/services/whatsapp/baileysClient');

const sockets = [];
function fakeLib() {
  return {
    useMultiFileAuthState: async (dir) => ({ state: { creds: { dir }, keys: {} }, saveCreds: async () => {} }),
    makeCacheableSignalKeyStore: (keys) => keys,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
    Browsers: { ubuntu: (n) => ['Ubuntu', n, '1'] },
    downloadMediaMessage: async () => Buffer.from('conteudo-do-anexo'),
    makeWASocket: (cfg) => {
      const ev = new EventEmitter();
      ev.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(ev);
      const sock = {
        cfg, ev, sent: [], ended: 0, user: { id: '5511999998888:12@s.whatsapp.net' },
        ws: { isOpen: true },
        end() { this.ended += 1; },
        onWhatsApp: async (jid) => (jid.startsWith('5511') ? [{ jid, exists: true }] : [{ jid, exists: false }]),
        sendMessage: async (jid, payload) => { sock.sent.push({ jid, payload }); return { key: { id: 'ABC', remoteJid: jid, fromMe: true } }; },
        signalRepository: { lidMapping: { getPNForLID: async () => '5511977776666@s.whatsapp.net', getLIDForPN: async () => '123@lid' } }
      };
      sockets.push(sock);
      return sock;
    }
  };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const novo = () => new BaileysClient({ clientId: 'abc', dataPath: os.tmpdir(), lib: fakeLib() });

test('QR, conexão aberta e eventos na ordem que o serviço espera', async () => {
  sockets.length = 0;
  const c = novo(); const eventos = [];
  ['qr', 'authenticated', 'ready'].forEach((e) => c.on(e, (x) => eventos.push(e + (x ? `:${x}` : ''))));
  await c.initialize();
  const sock = sockets[0];
  assert.equal(sock.cfg.syncFullHistory, false);
  assert.equal(sock.cfg.markOnlineOnConnect, false);
  assert.deepEqual(sock.cfg.version, [2, 3000, 1]);
  sock.ev.emit('connection.update', { qr: 'CODIGO-QR' });
  sock.ev.emit('connection.update', { connection: 'open' });
  assert.deepEqual(eventos, ['qr:CODIGO-QR', 'authenticated', 'ready']);
  assert.equal(c.info.wid.user, '5511999998888');
  assert.equal(await c.getState(), 'CONNECTED');
  sock.ws.isOpen = false;
  assert.equal(await c.getState(), 'DISCONNECTED', 'socket caído sem aviso é detectado pelo monitor de saúde');
  await c.destroy();
});

test('fechar com 515 (depois do QR) reabre sozinho e NÃO conta como queda', async () => {
  sockets.length = 0;
  const c = novo(); const caidas = [];
  c.on('disconnected', (r) => caidas.push(r));
  await c.initialize();
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await tick(700);
  assert.equal(sockets.length, 2, 'novo socket aberto');
  assert.deepEqual(caidas, []);
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.equal(await c.getState(), 'CONNECTED');
  await c.destroy();
});

test('motivos de desconexão viram o texto que o serviço já sabe tratar', async () => {
  const casos = [[401, /LOGOUT/], [500, /UNPAIRED/], [411, /UNPAIRED/], [440, /CONFLICT/], [428, /código 428/]];
  for (const [codigo, regex] of casos) {
    sockets.length = 0;
    const c = novo(); let motivo = null;
    c.on('disconnected', (r) => { motivo = r; });
    await c.initialize();
    sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: codigo } } } });
    assert.match(motivo, regex, `código ${codigo}`);
    await c.destroy();
  }
});

test('mensagem recebida: texto, LID com telefone, anúncio, mídia e baixar de novo', async () => {
  sockets.length = 0;
  const c = novo(); const msgs = [];
  c.on('message', (m) => msgs.push(m));
  await c.initialize();
  const ev = sockets[0].ev;
  ev.emit('connection.update', { connection: 'open' });
  ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: 'H1', remoteJid: '5511@s.whatsapp.net' }, message: { conversation: 'histórico' } }] });
  ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { id: 'T1', remoteJid: '5511988887777@s.whatsapp.net' }, pushName: 'Maria', message: { conversation: 'oi' } },
      { key: { id: 'T2', remoteJid: '999@lid', remoteJidAlt: '5511955554444@s.whatsapp.net' }, message: {
        extendedTextMessage: { text: 'vim do anúncio', contextInfo: { externalAdReply: { sourceId: 'AD1', sourceUrl: 'http://x', title: 'Promo' } } } } },
      { key: { id: 'M1', remoteJid: '5511933332222@s.whatsapp.net' }, message: { viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto' } } } } },
      { key: { id: 'A1', remoteJid: '5511933332222@s.whatsapp.net' }, message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } },
      { key: { id: 'S1', remoteJid: 'status@broadcast' }, message: { conversation: 'status' } },
      { key: { id: 'P1', remoteJid: '5511@s.whatsapp.net' } }
    ]
  });
  assert.equal(msgs.length, 4, 'ignora histórico, status e mensagem vazia');
  assert.deepEqual([msgs[0].from, msgs[0].body, msgs[0].hasMedia, msgs[0].type], ['5511988887777@c.us', 'oi', false, 'chat']);
  assert.equal((await msgs[0].getContact()).pushname, 'Maria');
  assert.equal(msgs[1].from, '5511955554444@c.us', 'LID resolvido para o telefone');
  assert.deepEqual(msgs[1]._data.ctwaContext, { sourceId: 'AD1', sourceUrl: 'http://x', title: 'Promo' });
  assert.deepEqual([msgs[2].type, msgs[2].body, msgs[2].hasMedia], ['image', 'foto', true]);
  assert.equal(msgs[3].type, 'ptt');
  const baixado = await msgs[2].downloadMedia();
  assert.equal(Buffer.from(baixado.data, 'base64').toString(), 'conteudo-do-anexo');
  assert.equal(baixado.mimetype, 'image/jpeg');
  // "Tentar baixar de novo" procura pelo id completo salvo no chat
  const achada = await c.getMessageById(msgs[2].id._serialized);
  assert.equal(achada.body, 'foto');
  assert.equal(await c.getMessageById('false_x_inexistente'), null);
  await c.destroy();
});

test('envio: texto, foto, documento, áudio normal e de voz; consulta de número', async () => {
  sockets.length = 0;
  const c = novo();
  await c.initialize();
  const sock = sockets[0];
  await assert.rejects(c.sendMessage('5511@c.us', 'x'), /not connected/i);
  sock.ev.emit('connection.update', { connection: 'open' });

  const b64 = Buffer.from('dados').toString('base64');
  await c.sendMessage('5511988887777@c.us', 'olá');
  await c.sendMessage('5511988887777@c.us', { mimetype: 'image/png', data: b64, filename: 'a.png' }, { caption: 'legenda' });
  await c.sendMessage('5511988887777@c.us', { mimetype: 'application/pdf', data: b64, filename: 'a.pdf' }, { caption: 'doc' });
  await c.sendMessage('5511988887777@c.us', { mimetype: 'image/png', data: b64, filename: 'b.png' }, { sendMediaAsDocument: true });
  await c.sendMessage('5511988887777@c.us', { mimetype: 'audio/ogg; codecs=opus', data: b64 }, { sendAudioAsVoice: true });
  await c.sendMessage('5511988887777@c.us', { mimetype: 'audio/mpeg', data: b64 }, {});
  const [t, img, pdf, asDoc, voz, audio] = sock.sent;
  assert.equal(t.jid, '5511988887777@s.whatsapp.net');
  assert.deepEqual(t.payload, { text: 'olá' });
  assert.ok(img.payload.image && img.payload.caption === 'legenda');
  assert.ok(pdf.payload.document && pdf.payload.fileName === 'a.pdf' && pdf.payload.mimetype === 'application/pdf');
  assert.ok(asDoc.payload.document, 'foto enviada como documento quando pedido');
  assert.ok(voz.payload.ptt === true && voz.payload.mimetype === 'audio/ogg; codecs=opus');
  assert.ok(audio.payload.audio && !audio.payload.ptt);

  assert.deepEqual(await c.getNumberId('5511988887777'), { user: '5511988887777', server: 'c.us', _serialized: '5511988887777@c.us' });
  assert.equal(await c.getNumberId('4499'), null);
  const [info] = await c.getContactLidAndPhone(['123@lid']);
  assert.equal(info.pn, '5511977776666@c.us');
  await c.destroy();
});

test('destroy fecha o socket, ignora eventos tardios e não reabre', async () => {
  sockets.length = 0;
  const c = novo(); let disparou = 0;
  c.on('disconnected', () => { disparou += 1; });
  await c.initialize();
  const sock = sockets[0];
  await c.destroy();
  assert.equal(sock.ended, 1);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await tick(700);
  assert.equal(sockets.length, 1, 'não reabriu depois de destruído');
  assert.equal(disparou, 0);
  assert.equal(await c.getState(), 'DISCONNECTED');
});

test('sem a biblioteca instalada: erro claro (e o resto do sistema não cai)', async () => {
  const c = new BaileysClient({ clientId: 'x', dataPath: os.tmpdir() });
  await assert.rejects(c.initialize(), /Baileys|baileys|npm install/);
});
