// backend/src/services/smsgw/smpp.js
//
// Cliente SMPP 3.4 próprio (sem dependências): é o protocolo que as operadoras e atacadistas de SMS
// (inclusive os que a Zenvia, Infobip, Sinch e Pontaltech usam entre si) oferecem para envio em massa.
// Faz: conexão (TCP/TLS), bind_transceiver, janela de envios simultâneos, limite de envios por segundo (TPS),
// enquire_link (mantém a ligação viva), reconexão automática, envio (submit_sm) e recebimento
// de relatórios de entrega (DLR) e de respostas dos clientes (MO) via deliver_sm.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { decodeSms } = require('./gsm');

const CMD = {
  generic_nack: 0x80000000,
  bind_receiver: 0x00000001,
  bind_transmitter: 0x00000002,
  bind_transceiver: 0x00000009,
  unbind: 0x00000006,
  submit_sm: 0x00000004,
  deliver_sm: 0x00000005,
  enquire_link: 0x00000015
};
const RESP = 0x80000000;

const STATUS = {
  ESME_ROK: 0x00,
  ESME_RINVMSGLEN: 0x01,
  ESME_RINVCMDLEN: 0x02,
  ESME_RINVCMDID: 0x03,
  ESME_RINVBNDSTS: 0x04,
  ESME_RALYBND: 0x05,
  ESME_RSYSERR: 0x08,
  ESME_RINVSRCADR: 0x0a,
  ESME_RINVDSTADR: 0x0b,
  ESME_RBINDFAIL: 0x0d,
  ESME_RINVPASWD: 0x0e,
  ESME_RINVSYSID: 0x0f,
  ESME_RSUBMITFAIL: 0x45,
  ESME_RTHROTTLED: 0x58,
  ESME_RINVSCHED: 0x61,
  ESME_RINVEXPIRY: 0x62,
  ESME_RX_T_APPN: 0x64,
  ESME_RX_P_APPN: 0x65,
  ESME_RX_R_APPN: 0x66,
  ESME_RQUEUEFULL: 0x14
};
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

const TLV = { receipted_message_id: 0x001e, message_state: 0x0427, message_payload: 0x0424, sar_msg_ref_num: 0x020c, sar_total_segments: 0x020e, sar_segment_seqnum: 0x020f };

/** Erros que valem tentar de novo / trocar de fornecedor (temporários). Os demais são definitivos (número inválido etc.). */
const TEMPORARY = new Set([STATUS.ESME_RSYSERR, STATUS.ESME_RTHROTTLED, STATUS.ESME_RQUEUEFULL, STATUS.ESME_RSUBMITFAIL, STATUS.ESME_RX_T_APPN]);

function cstr(s, max) {
  const b = Buffer.from(String(s || ''), 'latin1').subarray(0, max - 1);
  return Buffer.concat([b, Buffer.from([0])]);
}

function readCstr(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return { value: buf.toString('latin1', offset, end), next: end + 1 };
}

function encodePdu(commandId, status, seq, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0);
  header.writeUInt32BE(commandId >>> 0, 4);
  header.writeUInt32BE(status >>> 0, 8);
  header.writeUInt32BE(seq >>> 0, 12);
  return Buffer.concat([header, body]);
}

function tlvBuf(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const h = Buffer.alloc(4);
  h.writeUInt16BE(tag, 0);
  h.writeUInt16BE(v.length, 2);
  return Buffer.concat([h, v]);
}

function parseTlvs(buf, offset) {
  const out = {};
  let i = offset;
  while (i + 4 <= buf.length) {
    const tag = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    out[tag] = buf.subarray(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** Corpo comum de submit_sm / deliver_sm. */
function buildSubmitBody(p) {
  const parts = [
    cstr(p.serviceType || '', 6),
    Buffer.from([p.sourceTon ?? 5, p.sourceNpi ?? 0]),
    cstr(p.from, 21),
    Buffer.from([p.destTon ?? 1, p.destNpi ?? 1]),
    cstr(p.to, 21),
    Buffer.from([p.esmClass || 0, 0, 0]), // esm_class, protocol_id, priority_flag
    cstr('', 17), // schedule_delivery_time
    cstr(p.validity || '', 17), // validity_period
    Buffer.from([p.registeredDelivery ?? 1, 0, p.dataCoding || 0, 0]), // registered_delivery, replace, data_coding, sm_default_msg_id
    Buffer.from([p.shortMessage.length]),
    p.shortMessage
  ];
  for (const t of p.tlvs || []) parts.push(tlvBuf(t.tag, t.value));
  return Buffer.concat(parts);
}

function parseDeliverBody(body) {
  let i = 0;
  const serviceType = readCstr(body, i); i = serviceType.next;
  i += 2; // source ton/npi
  const from = readCstr(body, i); i = from.next;
  i += 2;
  const to = readCstr(body, i); i = to.next;
  const esmClass = body[i]; i += 3; // esm_class, protocol_id, priority_flag
  const sched = readCstr(body, i); i = sched.next;
  const validity = readCstr(body, i); i = validity.next;
  i += 2; // registered_delivery, replace_if_present
  const dataCoding = body[i]; i += 2; // data_coding, sm_default_msg_id
  const smLength = body[i]; i += 1;
  const shortMessage = body.subarray(i, i + smLength);
  i += smLength;
  const tlvs = parseTlvs(body, i);
  return { from: from.value, to: to.value, esmClass, dataCoding, shortMessage, tlvs };
}

/** Lê "id:123 sub:001 dlvrd:001 submit date:... done date:... stat:DELIVRD err:000 text:..." */
function parseDlrText(text) {
  const get = (re) => (text.match(re) || [])[1];
  return {
    id: get(/id:([^\s]+)/i),
    stat: (get(/stat:([A-Z_]+)/i) || '').toUpperCase(),
    err: get(/err:([0-9A-Za-z]+)/i) || ''
  };
}

class SmppSession extends EventEmitter {
  /**
   * @param {{host, port, tls?, systemId, password, systemType?, windowSize?, tps?, enquireLinkSec?,
   *          connectTimeoutMs?, requestTimeoutMs?, bindType?, addrTon?, addrNpi?}} cfg
   */
  constructor(cfg) {
    super();
    this.cfg = { windowSize: 10, tps: 10, enquireLinkSec: 30, connectTimeoutMs: 15000, requestTimeoutMs: 30000, bindType: 'transceiver', ...cfg };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.state = 'closed'; // closed | connecting | bound
    this.lastError = null;
    this.stopped = true;
    this.backoff = 2000;
    this.inflight = 0;
    this.waiters = [];
    this.nextSlotAt = 0;
    this.timers = [];
  }

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.emit('state', state, this.lastError);
  }

  nextSeq() {
    this.seq = (this.seq % 0x7fffffff) + 1;
    return this.seq;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      try {
        if (this.state === 'bound') this.socket.write(encodePdu(CMD.unbind, 0, this.nextSeq()));
        setTimeout(() => this.socket && this.socket.destroy(), 200);
      } catch (_) { /* ignore */ }
    }
    this.failPending(new Error('Sessão encerrada'));
    this.setState('closed');
  }

  clearTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  failPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.inflight = 0;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((fn) => fn(err));
  }

  connect() {
    if (this.stopped) return;
    this.setState('connecting');
    this.buffer = Buffer.alloc(0);
    const { host, port } = this.cfg;
    const onConnect = () => {
      this.send(CMD.bind_transceiver, 0, Buffer.concat([
        cstr(this.cfg.systemId, 16),
        cstr(this.cfg.password, 9),
        cstr(this.cfg.systemType || '', 13),
        Buffer.from([0x34, this.cfg.addrTon || 0, this.cfg.addrNpi || 0]),
        cstr('', 41)
      ]), true)
        .then(() => {
          this.backoff = 2000;
          this.setState('bound', null);
          this.timers.push(setInterval(() => this.keepAlive(), this.cfg.enquireLinkSec * 1000));
          this.emit('bound');
        })
        .catch((e) => {
          this.lastError = `Falha no login (bind): ${e.message}`;
          this.socket && this.socket.destroy();
        });
    };
    const opts = { host, port };
    const sock = this.cfg.tls ? tls.connect({ ...opts, servername: host }, onConnect) : net.connect(opts, onConnect);
    this.socket = sock;
    sock.setTimeout(this.cfg.connectTimeoutMs, () => {
      if (this.state === 'connecting') {
        this.lastError = 'Tempo esgotado ao conectar no servidor SMPP';
        sock.destroy();
      }
    });
    sock.on('connect', () => sock.setTimeout(0));
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => {
      this.lastError = e.message;
    });
    sock.on('close', () => {
      this.clearTimers();
      this.failPending(new Error('Conexão SMPP caiu'));
      if (this.socket === sock) this.socket = null;
      this.setState('closed');
      if (!this.stopped) {
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 60000);
        setTimeout(() => this.connect(), wait);
      }
    });
  }

  keepAlive() {
    if (this.state !== 'bound') return;
    this.send(CMD.enquire_link, 0, Buffer.alloc(0), true).catch(() => {
      this.lastError = 'Servidor não respondeu ao enquire_link; reconectando';
      this.socket && this.socket.destroy();
    });
  }

  /** Envia um PDU de pedido e espera a resposta (resp). */
  send(commandId, status, body, bypassWindow = false) {
    return new Promise((resolve, reject) => {
      if (!this.socket || (!bypassWindow && this.state !== 'bound')) return reject(new Error('Sessão SMPP não está conectada'));
      const seq = this.nextSeq();
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('Tempo esgotado esperando resposta do servidor SMPP'));
      }, this.cfg.requestTimeoutMs);
      this.pending.set(seq, { resolve, reject, timer, commandId, window: !bypassWindow });
      this.socket.write(encodePdu(commandId, status, seq, body));
    });
  }

  releaseSlot() {
    this.inflight = Math.max(0, this.inflight - 1);
    const w = this.waiters.shift();
    if (w) w();
  }

  async acquireSlot() {
    // janela de envios simultâneos
    while (this.inflight >= this.cfg.windowSize) {
      await new Promise((resolve, reject) => this.waiters.push((err) => (err ? reject(err) : resolve())));
    }
    this.inflight += 1;
    // TPS: espaça os envios
    const gap = 1000 / Math.max(0.1, this.cfg.tps);
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  /**
   * Envia 1 mensagem (já dividida em partes). Retorna os ids do SMSC de cada parte.
   * @param {{from,to,segments:Buffer[],dataCoding,concat?:'udh'|'sar',registeredDelivery?,validity?}} m
   */
  async submit(m) {
    if (this.state !== 'bound') {
      const e = new Error('Sessão SMPP desconectada');
      e.temporary = true;
      throw e;
    }
    const ref = Math.floor(Math.random() * 255);
    const ids = [];
    for (let i = 0; i < m.segments.length; i += 1) {
      const multi = m.segments.length > 1;
      let shortMessage = m.segments[i];
      let esmClass = 0;
      const tlvs = [];
      if (multi && (m.concat || 'udh') === 'udh') {
        shortMessage = Buffer.concat([Buffer.from([0x05, 0x00, 0x03, ref, m.segments.length, i + 1]), shortMessage]);
        esmClass = 0x40;
      } else if (multi) {
        tlvs.push({ tag: TLV.sar_msg_ref_num, value: Buffer.from([0, ref]) });
        tlvs.push({ tag: TLV.sar_total_segments, value: Buffer.from([m.segments.length]) });
        tlvs.push({ tag: TLV.sar_segment_seqnum, value: Buffer.from([i + 1]) });
      }
      const body = buildSubmitBody({
        from: m.from,
        to: m.to,
        sourceTon: /^\d+$/.test(m.from) ? (m.from.length <= 8 ? 3 : 1) : 5,
        sourceNpi: /^\d+$/.test(m.from) ? 1 : 0,
        destTon: 1,
        destNpi: 1,
        shortMessage,
        dataCoding: m.dataCoding,
        esmClass,
        registeredDelivery: m.registeredDelivery ?? 1,
        validity: m.validity,
        tlvs
      });
      await this.acquireSlot();
      try {
        const resp = await this.send(CMD.submit_sm, 0, body);
        ids.push(readCstr(resp.body, 0).value);
      } catch (e) {
        this.releaseSlot();
        throw e;
      }
      this.releaseSlot();
    }
    return ids;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 16) {
      const len = this.buffer.readUInt32BE(0);
      if (len < 16 || len > 70000) {
        this.socket && this.socket.destroy();
        return;
      }
      if (this.buffer.length < len) return;
      const pdu = this.buffer.subarray(0, len);
      this.buffer = this.buffer.subarray(len);
      this.onPdu({
        id: pdu.readUInt32BE(4) >>> 0,
        status: pdu.readUInt32BE(8),
        seq: pdu.readUInt32BE(12),
        body: pdu.subarray(16)
      });
    }
  }

  onPdu(pdu) {
    if (pdu.id & RESP) {
      const p = this.pending.get(pdu.seq);
      if (!p) return;
      this.pending.delete(pdu.seq);
      clearTimeout(p.timer);
      if (pdu.status === 0) return p.resolve(pdu);
      const err = new Error(`${STATUS_NAME[pdu.status] || `erro 0x${pdu.status.toString(16)}`} (0x${pdu.status.toString(16)})`);
      err.smppStatus = pdu.status;
      err.temporary = TEMPORARY.has(pdu.status);
      return p.reject(err);
    }
    if (pdu.id === CMD.enquire_link) {
      this.socket.write(encodePdu(CMD.enquire_link | RESP, 0, pdu.seq));
      return;
    }
    if (pdu.id === CMD.unbind) {
      this.socket.write(encodePdu(CMD.unbind | RESP, 0, pdu.seq));
      this.socket.end();
      return;
    }
    if (pdu.id === CMD.deliver_sm) {
      let ok = true;
      try {
        this.handleDeliver(parseDeliverBody(pdu.body));
      } catch (e) {
        ok = false;
        this.lastError = `deliver_sm inválido: ${e.message}`;
      }
      this.socket.write(encodePdu(CMD.deliver_sm | RESP, ok ? 0 : STATUS.ESME_RSYSERR, pdu.seq, Buffer.from([0])));
    }
  }

  handleDeliver(d) {
    const isReceipt = (d.esmClass & 0x3c) === 0x04;
    const payload = d.tlvs[TLV.message_payload] || d.shortMessage;
    if (isReceipt) {
      const text = payload.toString('latin1');
      const info = parseDlrText(text);
      const tlvId = d.tlvs[TLV.receipted_message_id];
      const id = tlvId ? tlvId.toString('latin1').replace(/\0+$/, '') : info.id;
      let stat = info.stat;
      if (!stat && d.tlvs[TLV.message_state]) {
        const map = { 1: 'ENROUTE', 2: 'DELIVRD', 3: 'EXPIRED', 4: 'DELETED', 5: 'UNDELIV', 6: 'ACCEPTD', 7: 'UNKNOWN', 8: 'REJECTD' };
        stat = map[d.tlvs[TLV.message_state][0]] || 'UNKNOWN';
      }
      this.emit('dlr', { smscId: id, stat, err: info.err, raw: text });
    } else {
      let data = payload;
      if (d.esmClass & 0x40 && data.length > 6 && data[0] === 0x05) data = data.subarray(6); // tira o UDH
      this.emit('mo', { from: d.from, to: d.to, text: decodeSms(data, d.dataCoding) });
    }
  }
}

module.exports = {
  SmppSession,
  CMD,
  RESP,
  STATUS,
  STATUS_NAME,
  TLV,
  encodePdu,
  buildSubmitBody,
  parseDeliverBody,
  parseDlrText,
  cstr,
  readCstr,
  tlvBuf
};
