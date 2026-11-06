// frontend/src/utils/sipClient.js
//
// Telefone SIP no navegador, sem biblioteca externa: fala SIP sobre WebSocket (RFC 7118) com o Asterisk
// e usa o WebPhoneEngine (WebRTC) para o áudio. Faz: registro com senha (digest MD5), ligar, receber,
// atender, recusar, desligar, cancelar, teclas (DTMF) e reconexão automática.

// ---------------------------------------------------------------- MD5 (a senha digest do SIP usa MD5)
export function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  const K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len << 3) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 536870912), true);
  let a0 = 0x67452301; let b0 = 0xefcdab89 | 0; let c0 = 0x98badcfe | 0; let d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F; let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const rand = (n = 10) => Array.from({ length: n }, () => Math.floor(Math.random() * 36).toString(36)).join('');
const branch = () => `z9hG4bK${rand(12)}`;

// ---------------------------------------------------------------- mensagens SIP
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type' };

export function parseSip(text) {
  const sep = text.indexOf('\r\n\r\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : '';
  const lines = head.split('\r\n');
  const first = lines.shift();
  const msg = { headers: {}, body, raw: text };
  const resp = first.match(/^SIP\/2\.0 (\d{3}) (.*)$/);
  if (resp) {
    msg.isResponse = true;
    msg.status = Number(resp[1]);
    msg.reason = resp[2];
  } else {
    const req = first.match(/^([A-Z]+) (\S+) SIP\/2\.0$/);
    if (!req) return null;
    msg.method = req[1];
    msg.uri = req[2];
  }
  let last = null;
  for (const line of lines) {
    if (/^\s/.test(line) && last) { msg.headers[last][msg.headers[last].length - 1] += ` ${line.trim()}`; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    let name = line.slice(0, idx).trim().toLowerCase();
    name = COMPACT[name] || name;
    const value = line.slice(idx + 1).trim();
    (msg.headers[name] = msg.headers[name] || []).push(value);
    last = name;
  }
  return msg;
}

const h = (msg, name) => (msg.headers[name] || [])[0];
const tagOf = (hdr) => (String(hdr || '').match(/;\s*tag=([^;>\s]+)/i) || [])[1];
const cseqOf = (msg) => { const m = String(h(msg, 'cseq') || '').match(/(\d+)\s+(\w+)/); return m ? { n: Number(m[1]), method: m[2] } : {}; };
const uriOf = (hdr) => (String(hdr || '').match(/<([^>]+)>/) || String(hdr || '').match(/(sip:[^;\s>]+)/) || [])[1];

function parseChallenge(value) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function digestHeader({ challenge, method, uri, username, password, nc = 1 }) {
  const qopAuth = /auth/.test(challenge.qop || '');
  const cnonce = rand(10);
  const ncv = nc.toString(16).padStart(8, '0');
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qopAuth
    ? md5(`${ha1}:${challenge.nonce}:${ncv}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  let v = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
  if (challenge.opaque) v += `, opaque="${challenge.opaque}"`;
  if (qopAuth) v += `, qop=auth, cnonce="${cnonce}", nc=${ncv}`;
  return v;
}

// ---------------------------------------------------------------- cliente
export class SipClient {
  /**
   * @param {{wssUrl, domain, extension, password, displayName?, iceServers?, WebSocketImpl?, engineFactory?,
   *   onRegState?(state), onIncoming?(call), onLog?(line), registerExpires?}} cfg
   * regState: 'offline' | 'connecting' | 'registered' | 'error'
   */
  constructor(cfg) {
    this.cfg = { registerExpires: 120, ...cfg };
    this.WS = cfg.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.ws = null;
    this.stopped = true;
    this.regState = 'offline';
    this.regCallId = `${rand(16)}@${cfg.domain}`;
    this.regCseq = 1;
    this.contactHost = `${rand(10)}.invalid`;
    this.transportName = /^wss:/i.test(cfg.wssUrl) ? 'WSS' : 'WS';
    this.regTimer = null;
    this.reconnectTimer = null;
    this.backoff = 1500;
    this.calls = new Map(); // call-id -> Call
    this.regAuthTried = false;
  }

  log(s) { this.cfg.onLog && this.cfg.onLog(s); }
  setReg(state, detail) {
    this.regState = state;
    this.regDetail = detail;
    this.cfg.onRegState && this.cfg.onRegState(state, detail);
  }
  get aor() { return `sip:${this.cfg.extension}@${this.cfg.domain}`; }
  get contact() { return `<sip:${this.cfg.extension}@${this.contactHost};transport=ws>`; }
  fromHeader(tag) { return `"${(this.cfg.displayName || this.cfg.extension).replace(/"/g, '')}" <${this.aor}>;tag=${tag}`; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.regTimer);
    clearTimeout(this.reconnectTimer);
    for (const call of [...this.calls.values()]) call.hangup();
    if (this.ws && this.regState === 'registered') {
      try { this.sendRegister(0); } catch { /* ignore */ }
    }
    setTimeout(() => { try { this.ws && this.ws.close(); } catch { /* ignore */ } }, 150);
    this.setReg('offline');
  }

  connect() {
    if (this.stopped) return;
    this.setReg('connecting');
    let ws;
    try { ws = new this.WS(this.cfg.wssUrl, 'sip'); } catch (e) { this.setReg('error', e.message); return this.scheduleReconnect(); }
    this.ws = ws;
    ws.onopen = () => { this.regAuthTried = false; this.sendRegister(this.cfg.registerExpires); };
    ws.onmessage = (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : '');
    ws.onerror = () => { /* o close vem em seguida */ };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      clearTimeout(this.regTimer);
      if (!this.stopped) {
        this.setReg('error', 'Sem conexão com o servidor de telefonia. Tentando de novo…');
        this.scheduleReconnect();
      }
    };
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  send(text) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('Sem conexão com o servidor de telefonia');
    this.log(`>> ${text.split('\r\n')[0]}`);
    this.ws.send(text);
  }

  // ---- REGISTER
  sendRegister(expires, authHeader) {
    const lines = [
      `REGISTER sip:${this.cfg.domain} SIP/2.0`,
      `Via: SIP/2.0/${this.transportName} ${this.contactHost};branch=${branch()}`,
      'Max-Forwards: 70',
      `From: ${this.fromHeader(this.regTag || (this.regTag = rand(8)))}`,
      `To: <${this.aor}>`,
      `Call-ID: ${this.regCallId}`,
      `CSeq: ${this.regCseq} REGISTER`,
      `Contact: ${this.contact};expires=${expires}`,
      `Expires: ${expires}`,
      'Allow: INVITE,ACK,CANCEL,BYE,OPTIONS,MESSAGE',
      'User-Agent: TurboProspect-Phone',
      ...(authHeader ? [authHeader] : []),
      'Content-Length: 0',
      '', ''
    ];
    this.lastRegExpires = expires;
    this.send(lines.join('\r\n'));
  }

  onRegisterResponse(msg) {
    if (msg.status === 401 || msg.status === 407) {
      if (this.regAuthTried) { this.setReg('error', 'Ramal ou senha recusados pelo servidor de telefonia.'); return; }
      this.regAuthTried = true;
      const ch = parseChallenge(h(msg, msg.status === 401 ? 'www-authenticate' : 'proxy-authenticate'));
      this.regCseq += 1;
      const value = digestHeader({ challenge: ch, method: 'REGISTER', uri: `sip:${this.cfg.domain}`, username: this.cfg.extension, password: this.cfg.password });
      this.sendRegister(this.lastRegExpires, `${msg.status === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${value}`);
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      this.regAuthTried = false;
      this.backoff = 1500;
      if (this.lastRegExpires === 0) return;
      this.setReg('registered');
      clearTimeout(this.regTimer);
      this.regTimer = setTimeout(() => {
        this.regCseq += 1;
        try { this.sendRegister(this.cfg.registerExpires); } catch { /* reconecta no close */ }
      }, Math.max(15, this.cfg.registerExpires * 0.5) * 1000);
      return;
    }
    if (msg.status >= 300) this.setReg('error', `Registro recusado (${msg.status} ${msg.reason})`);
  }

  // ---- roteamento das mensagens
  onMessage(text) {
    if (/^\s*$/.test(text)) return;
    const msg = parseSip(text);
    if (!msg) return;
    this.log(`<< ${text.split('\r\n')[0]}`);
    const callId = h(msg, 'call-id');
    if (msg.isResponse) {
      if (callId === this.regCallId) return this.onRegisterResponse(msg);
      const call = this.calls.get(callId);
      if (call) call.onResponse(msg);
      return;
    }
    if (msg.method === 'OPTIONS') return this.reply(msg, 200, 'OK');
    if (msg.method === 'INVITE') {
      const existing = this.calls.get(callId);
      if (existing) return existing.onReinvite && existing.onReinvite(msg);
      const call = new Call(this, 'in', msg);
      this.calls.set(callId, call);
      return call.onInvite(msg);
    }
    const call = this.calls.get(callId);
    if (call) return call.onRequest(msg);
    if (msg.method === 'ACK') return undefined;
    return this.reply(msg, msg.method === 'BYE' || msg.method === 'CANCEL' ? 481 : 405, msg.method === 'BYE' || msg.method === 'CANCEL' ? 'Call/Transaction Does Not Exist' : 'Method Not Allowed');
  }

  /** Responde a um pedido recebido, copiando Via/From/To/Call-ID/CSeq. */
  reply(req, status, reason, { toTag, body, extra = [] } = {}) {
    let to = h(req, 'to');
    if (toTag && !/;\s*tag=/i.test(to)) to += `;tag=${toTag}`;
    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      ...(req.headers.via || []).map((v) => `Via: ${v}`),
      ...(req.headers['record-route'] || []).map((v) => `Record-Route: ${v}`),
      `From: ${h(req, 'from')}`,
      `To: ${to}`,
      `Call-ID: ${h(req, 'call-id')}`,
      `CSeq: ${h(req, 'cseq')}`,
      ...extra,
      'User-Agent: TurboProspect-Phone',
      ...(body ? ['Content-Type: application/sdp', `Content-Length: ${new TextEncoder().encode(body).length}`] : ['Content-Length: 0']),
      '', body || ''
    ];
    this.send(lines.join('\r\n'));
  }

  // ---- ligar
  call(number) {
    const digits = String(number || '').replace(/[^\d*#+]/g, '');
    if (!digits) throw new Error('Informe o número');
    const call = new Call(this, 'out', null, digits);
    this.calls.set(call.callId, call);
    call.startOutgoing();
    return call;
  }

  remove(call) { this.calls.delete(call.callId); }
}

// ---------------------------------------------------------------- uma chamada
export class Call {
  constructor(client, direction, invite, number) {
    this.client = client;
    this.direction = direction;
    this.state = direction === 'out' ? 'calling' : 'incoming'; // calling | ringing | incoming | connected | ended
    this.endReason = null;
    this.startedAt = Date.now();
    this.answeredAt = null;
    this.muted = false;
    this.listeners = [];
    this.engine = null;
    this.answerApplied = false;
    this.cseq = 1;
    this.authTried = false;
    this.routeSet = [];
    this.engineFactory = client.cfg.engineFactory;
    this.ended = false;
    if (direction === 'out') {
      this.number = number;
      this.callId = `${rand(20)}@${client.cfg.domain}`;
      this.localTag = rand(8);
      this.remoteUri = `sip:${number}@${client.cfg.domain}`;
    } else {
      this.invite = invite;
      this.callId = h(invite, 'call-id');
      this.localTag = rand(8);
      this.remoteTag = tagOf(h(invite, 'from'));
      const from = h(invite, 'from');
      this.number = (from.match(/sip:([^@>;]+)/) || [])[1] || 'desconhecido';
      this.displayName = (from.match(/^"([^"]*)"/) || [])[1] || null;
      this.remoteUri = uriOf(h(invite, 'contact')) || uriOf(from);
      this.routeSet = (invite.headers['record-route'] || []).slice();
    }
  }

  onChange(fn) { this.listeners.push(fn); }
  setState(state, reason) {
    if (this.state === state) return;
    this.state = state;
    if (reason) this.endReason = reason;
    this.listeners.forEach((fn) => { try { fn(this); } catch { /* ui */ } });
  }

  makeEngine() {
    this.engine = this.engineFactory({
      onState: (s) => { if (s === 'failed' && this.state === 'connected') this.hangup(); },
      onRemoteStream: (stream) => { this.remoteStream = stream; this.listeners.forEach((fn) => fn(this)); }
    });
    return this.engine;
  }

  // ---- saída
  async startOutgoing() {
    try {
      this.makeEngine();
      this.offerSdp = await this.engine.createOffer();
    } catch (e) {
      this.finish('failed', e.message || 'Não foi possível acessar o microfone');
      return;
    }
    if (this.ended) return;
    this.inviteBranch = branch();
    this.sendInvite();
  }

  sendInvite(authHeader) {
    const c = this.client;
    const lines = [
      `INVITE ${this.remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${c.transportName} ${c.contactHost};branch=${this.inviteBranch}`,
      'Max-Forwards: 70',
      `From: ${c.fromHeader(this.localTag)}`,
      `To: <${this.remoteUri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} INVITE`,
      `Contact: ${c.contact}`,
      'Allow: INVITE,ACK,CANCEL,BYE,OPTIONS',
      'Supported: replaces',
      'User-Agent: TurboProspect-Phone',
      ...(authHeader ? [authHeader] : []),
      'Content-Type: application/sdp',
      `Content-Length: ${new TextEncoder().encode(this.offerSdp).length}`,
      '', this.offerSdp
    ];
    try { c.send(lines.join('\r\n')); } catch (e) { this.finish('failed', e.message); }
  }

  onResponse(msg) {
    const { method } = cseqOf(msg);
    if (method === 'BYE') { if (msg.status >= 200) this.cleanup(); return; }
    if (method === 'CANCEL') return;
    if (method !== 'INVITE') return;
    const st = msg.status;
    if (st >= 100 && st < 200) {
      this.remoteTag = tagOf(h(msg, 'to')) || this.remoteTag;
      if (st === 180 || st === 183) this.setState('ringing');
      if (st === 183 && msg.body && /m=audio/.test(msg.body) && !this.answerApplied) {
        this.answerApplied = true;
        this.engine.acceptAnswer(msg.body).catch(() => { this.answerApplied = false; });
      }
      return;
    }
    if (st >= 200 && st < 300) {
      this.remoteTag = tagOf(h(msg, 'to')) || this.remoteTag;
      this.remoteUri = uriOf(h(msg, 'contact')) || this.remoteUri;
      this.routeSet = (msg.headers['record-route'] || []).slice().reverse();
      this.sendAck(msg);
      if (this.state === 'connected') return; // retransmissão do 200
      const done = () => { this.answeredAt = Date.now(); this.setState('connected'); };
      if (this.answerApplied) done();
      else {
        this.answerApplied = true;
        this.engine.acceptAnswer(msg.body).then(done).catch((e) => { this.sendBye(); this.finish('failed', `Áudio incompatível: ${e.message}`); });
      }
      return;
    }
    // respostas finais de erro: ACK obrigatório
    this.sendAckForError(msg);
    if ((st === 401 || st === 407) && !this.authTried) {
      this.authTried = true;
      const ch = parseChallenge(h(msg, st === 401 ? 'www-authenticate' : 'proxy-authenticate'));
      this.cseq += 1;
      this.inviteBranch = branch();
      const value = digestHeader({ challenge: ch, method: 'INVITE', uri: this.remoteUri, username: this.client.cfg.extension, password: this.client.cfg.password });
      this.sendInvite(`${st === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${value}`);
      return;
    }
    const map = { 486: ['busy', 'Ocupado'], 600: ['busy', 'Ocupado'], 603: ['rejected', 'Recusada'], 487: ['canceled', 'Cancelada'], 404: ['failed', 'Número não encontrado'], 480: ['failed', 'Indisponível'], 503: ['failed', 'Serviço indisponível'] };
    const [status, text] = this.localCanceled ? ['canceled', 'Cancelada'] : map[st] || ['failed', `Falhou (${st} ${msg.reason})`];
    this.finish(status, text);
  }

  sendAck(msg2xx) {
    const c = this.client;
    const lines = [
      `ACK ${this.remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${c.transportName} ${c.contactHost};branch=${branch()}`,
      'Max-Forwards: 70',
      ...this.routeSet.map((r) => `Route: ${r}`),
      `From: ${c.fromHeader(this.localTag)}`,
      `To: ${h(msg2xx, 'to')}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseqOf(msg2xx).n} ACK`,
      'Content-Length: 0', '', ''
    ];
    try { c.send(lines.join('\r\n')); } catch { /* ignore */ }
  }

  sendAckForError(msg) {
    const c = this.client;
    const lines = [
      `ACK ${this.remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${c.transportName} ${c.contactHost};branch=${this.inviteBranch}`,
      'Max-Forwards: 70',
      `From: ${c.fromHeader(this.localTag)}`,
      `To: ${h(msg, 'to')}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseqOf(msg).n} ACK`,
      'Content-Length: 0', '', ''
    ];
    try { c.send(lines.join('\r\n')); } catch { /* ignore */ }
  }

  // ---- entrada
  onInvite(msg) {
    const c = this.client;
    try {
      c.reply(msg, 100, 'Trying');
      c.reply(msg, 180, 'Ringing', { toTag: this.localTag, extra: [`Contact: ${c.contact}`] });
    } catch { /* ignore */ }
    this.offerSdp = msg.body;
    c.cfg.onIncoming && c.cfg.onIncoming(this);
  }

  async answer() {
    if (this.direction !== 'in' || this.state !== 'incoming') return;
    const c = this.client;
    try {
      this.makeEngine();
      const sdp = await this.engine.answerOffer(this.offerSdp);
      if (this.ended) { this.engine.close(); return; }
      c.reply(this.invite, 200, 'OK', { toTag: this.localTag, body: sdp, extra: [`Contact: ${c.contact}`] });
      this.answeredAt = Date.now();
      this.setState('connected');
    } catch (e) {
      try { c.reply(this.invite, 480, 'Temporarily Unavailable', { toTag: this.localTag }); } catch { /* ignore */ }
      this.finish('failed', e.message || 'Não foi possível atender');
    }
  }

  reject() {
    if (this.direction !== 'in' || this.state !== 'incoming') return;
    try { this.client.reply(this.invite, 603, 'Decline', { toTag: this.localTag }); } catch { /* ignore */ }
    this.finish('rejected', 'Recusada');
  }

  // ---- pedidos dentro da chamada
  onRequest(msg) {
    const c = this.client;
    if (msg.method === 'BYE') {
      try { c.reply(msg, 200, 'OK'); } catch { /* ignore */ }
      this.finish(this.answeredAt ? 'answered' : 'failed', 'Encerrada pelo outro lado');
    } else if (msg.method === 'CANCEL') {
      try {
        c.reply(msg, 200, 'OK');
        if (this.state === 'incoming') {
          c.reply(this.invite, 487, 'Request Terminated', { toTag: this.localTag });
          this.finish('missed', 'Perdida');
        }
      } catch { /* ignore */ }
    } else if (msg.method === 'OPTIONS' || msg.method === 'INFO' || msg.method === 'NOTIFY') {
      try { c.reply(msg, 200, 'OK'); } catch { /* ignore */ }
    }
    // ACK do 200: nada a fazer
  }

  // ---- encerrar
  hangup() {
    if (this.ended) return;
    if (this.direction === 'in' && this.state === 'incoming') return this.reject();
    if (this.state === 'connected') {
      this.sendBye();
      this.finish('answered', 'Encerrada');
    } else if (this.direction === 'out') {
      // ainda tocando: CANCEL (mesmo branch e CSeq do INVITE)
      this.localCanceled = true;
      if (this.inviteBranch) this.sendCancel();
      this.finish('canceled', 'Cancelada');
    } else {
      this.finish('failed', 'Encerrada');
    }
  }

  sendBye() {
    const c = this.client;
    this.cseq += 1;
    const lines = [
      `BYE ${this.remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${c.transportName} ${c.contactHost};branch=${branch()}`,
      'Max-Forwards: 70',
      ...this.routeSet.map((r) => `Route: ${r}`),
      `From: ${this.direction === 'out' ? c.fromHeader(this.localTag) : `${h(this.invite, 'to').replace(/;\s*tag=[^;>\s]+/i, '')};tag=${this.localTag}`}`,
      `To: ${this.direction === 'out' ? `<${this.remoteUri.replace(/;.*$/, '')}>` + (this.remoteTag ? `;tag=${this.remoteTag}` : '') : `${h(this.invite, 'from')}`}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq + (this.direction === 'in' ? 100 : 0)} BYE`,
      'Content-Length: 0', '', ''
    ];
    try { c.send(lines.join('\r\n')); } catch { /* ignore */ }
  }

  sendCancel() {
    const c = this.client;
    const lines = [
      `CANCEL ${this.remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${c.transportName} ${c.contactHost};branch=${this.inviteBranch}`,
      'Max-Forwards: 70',
      `From: ${c.fromHeader(this.localTag)}`,
      `To: <${this.remoteUri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} CANCEL`,
      'Content-Length: 0', '', ''
    ];
    try { c.send(lines.join('\r\n')); } catch { /* ignore */ }
  }

  setMuted(m) { this.muted = !!m; this.engine && this.engine.setMuted(this.muted); this.listeners.forEach((fn) => fn(this)); }
  sendDtmf(tone) { this.engine && this.engine.sendDtmf && this.engine.sendDtmf(tone); }

  finish(status, text) {
    if (this.ended) return;
    this.ended = true;
    this.finalStatus = status;
    this.endedAt = Date.now();
    this.setState('ended', text);
    setTimeout(() => this.cleanup(), 3000);
    try { this.engine && this.engine.close(); } catch { /* ignore */ }
  }

  cleanup() { this.client.remove(this); }
}
