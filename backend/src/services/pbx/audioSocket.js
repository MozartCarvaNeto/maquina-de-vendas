// backend/src/services/pbx/audioSocket.js
// Protocolo AudioSocket do Asterisk (TCP): quadros [tipo 1 byte][tamanho 2 bytes][dados].
//   0x00 desligou · 0x01 identificador (UUID, 16 bytes) · 0x03 DTMF · 0x10 áudio 16 bits 8 kHz · 0xff erro
const net = require('net');
const { EventEmitter } = require('events');

const KIND = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };
const FRAME_BYTES = 320; // 20 ms

function encodeFrame(kind, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(3);
  h[0] = kind;
  h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

function uuidFromBytes(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidToBytes(u) {
  return Buffer.from(String(u).replace(/-/g, ''), 'hex');
}

/** Uma ligação conectada ao backend. Eventos: 'audio'(Buffer 320), 'dtmf'(char), 'close'. */
class AudioSocketSession extends EventEmitter {
  constructor(socket, id) {
    super();
    this.socket = socket;
    this.id = id;
    this.closed = false;
  }

  sendAudio(frame) {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(KIND.AUDIO, frame));
  }

  hangup() {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(KIND.HANGUP));
    } catch (_) {
      /* já fechou */
    }
    setTimeout(() => this.socket.destroy(), 200).unref();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Servidor TCP (só aceita o próprio servidor, 127.0.0.1). onSession(session) é chamado após receber o UUID. */
function createAudioSocketServer(onSession, { host = '127.0.0.1', allow = null } = {}) {
  const server = net.createServer((socket) => {
    // sem senha no protocolo: com o Asterisk em outro servidor, só aceita o IP dele
    if (allow && !allow(socket.remoteAddress)) { socket.destroy(); return; }
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let session = null;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const kind = buf[0];
        const payload = buf.subarray(3, 3 + len);
        buf = buf.subarray(3 + len);
        if (kind === KIND.UUID && !session && len === 16) {
          session = new AudioSocketSession(socket, uuidFromBytes(payload));
          Promise.resolve(onSession(session)).catch((e) => {
            console.error('AudioSocket:', e.message);
            session.hangup();
          });
        } else if (!session) {
          socket.destroy();
          return;
        } else if (kind === KIND.AUDIO) session.emit('audio', Buffer.from(payload));
        else if (kind === KIND.DTMF) session.emit('dtmf', payload.toString('ascii'));
        else if (kind === KIND.HANGUP) {
          session._closed();
          socket.end();
        }
      }
    });
    socket.on('close', () => session && session._closed());
    socket.on('error', () => session && session._closed());
  });
  return server;
}

module.exports = { KIND, FRAME_BYTES, encodeFrame, uuidToBytes, uuidFromBytes, createAudioSocketServer, AudioSocketSession };
