// backend/src/services/whatsapp/baileysClient.js
//
// Cliente de WhatsApp SEM NAVEGADOR (biblioteca Baileys: fala direto com os servidores do WhatsApp por
// WebSocket). Uso de memória: dezenas de MB por número, em vez dos 300-500 MB de um Chromium.
//
// Esta classe imita a interface do `Client` do whatsapp-web.js (eventos 'qr', 'authenticated', 'ready',
// 'disconnected', 'message', 'call'; métodos initialize/destroy/getState/getNumberId/sendMessage...), por isso
// todo o resto do sistema (reconexão, monitor de saúde, chat, disparos, robô) continua igual.
//
// Ligado por WHATSAPP_DRIVER=baileys no .env. Padrão continua sendo o whatsapp-web.js.
const EventEmitter = require('events');
const path = require('path');

const WS_CLOSE = { loggedOut: 401, connectionReplaced: 440, restartRequired: 515, badSession: 500, multideviceMismatch: 411 };

// Logger mudo (a biblioteca exige um objeto com esses métodos).
const SILENT = {
  level: 'silent',
  child() { return SILENT; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
};

const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage'
];
const MEDIA_KEYS = {
  imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document',
  stickerMessage: 'sticker', ptvMessage: 'video'
};
const RECENT_LIMIT = 100;

let versionCache = null;

async function loadBaileys() {
  try {
    return require('@whiskeysockets/baileys');
  } catch (err) {
    if (err && err.code === 'ERR_REQUIRE_ESM') return import('@whiskeysockets/baileys');
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error('A biblioteca @whiskeysockets/baileys não está instalada. Rode "npm install" na pasta backend.');
    }
    throw err;
  }
}

const pick = (lib, name) => (lib && lib[name] !== undefined ? lib[name] : lib && lib.default ? lib.default[name] : undefined);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })])
    .finally(() => clearTimeout(timer));
}

const jidUser = (jid) => String(jid || '').split('@')[0].split(':')[0];
const toWid = (jid) => String(jid || '').replace('@s.whatsapp.net', '@c.us');
const toJid = (wid) => String(wid || '').replace('@c.us', '@s.whatsapp.net');

function unwrap(content) {
  let current = content || {};
  for (let i = 0; i < 5; i += 1) {
    const key = WRAPPERS.find((k) => current[k] && current[k].message);
    if (!key) break;
    current = current[key].message;
  }
  return current;
}

class BaileysClient extends EventEmitter {
  /**
   * @param {{clientId:string, dataPath:string, lib?:object}} opts  `lib` só para testes (dublê da biblioteca).
   */
  constructor({ clientId, dataPath, lib = null }) {
    super();
    this.clientId = clientId;
    this.authDir = path.join(dataPath, `session-${clientId}`);
    this.lib = lib;
    this.sock = null;
    this.connected = false;
    this.destroyed = false;
    this.info = null;
    this.recent = new Map();      // últimas mensagens recebidas com anexo (para "Tentar baixar de novo")
    this.restarts = 0;
    this.restartTimer = null;
  }

  async initialize() {
    this.lib = this.lib || (await loadBaileys());
    await this.open();
  }

  async open() {
    const lib = this.lib;
    const useMultiFileAuthState = pick(lib, 'useMultiFileAuthState');
    const makeWASocket = pick(lib, 'makeWASocket') || pick(lib, 'default');
    const makeCacheableSignalKeyStore = pick(lib, 'makeCacheableSignalKeyStore');
    const fetchLatestBaileysVersion = pick(lib, 'fetchLatestBaileysVersion');
    const Browsers = pick(lib, 'Browsers');

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    if (this.destroyed) return;

    // Versão do protocolo: consulta o GitHub (até 5s) e guarda por 6h; se falhar, usa a que vem na biblioteca.
    let version;
    if (versionCache && Date.now() - versionCache.at < 6 * 3600 * 1000) version = versionCache.version;
    else if (fetchLatestBaileysVersion) {
      const found = await withTimeout(Promise.resolve(fetchLatestBaileysVersion()).catch(() => null), 5000);
      if (found && found.version && found.isLatest !== false) {
        version = found.version;
        versionCache = { at: Date.now(), version };
      }
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      logger: SILENT,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, SILENT) : state.keys
      },
      browser: Browsers && Browsers.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '120.0.0'],
      printQRInTerminal: false,
      markOnlineOnConnect: false,          // não "rouba" as notificações do celular
      syncFullHistory: false,              // não baixa o histórico antigo (economia de memória e de tempo)
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      getMessage: async () => undefined
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      Promise.resolve(saveCreds()).catch((err) => console.error(`[${this.clientId}] Falha ao salvar credenciais:`, err.message));
    });
    sock.ev.on('connection.update', (update) => this.onConnection(sock, update));
    sock.ev.on('messages.upsert', (event) => this.onMessages(sock, event));
    sock.ev.on('call', (calls) => this.onCalls(sock, calls));
  }

  onConnection(sock, update) {
    if (sock !== this.sock || this.destroyed) return;
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) this.emit('qr', qr);

    if (connection === 'open') {
      this.connected = true;
      this.restarts = 0;
      this.info = { wid: { user: jidUser(sock.user && sock.user.id), _serialized: toWid(sock.user && sock.user.id) } };
      this.emit('authenticated');
      this.emit('ready');
      return;
    }

    if (connection === 'close') {
      this.connected = false;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      const detail = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || '';

      // Depois de ler o QR o WhatsApp pede para reabrir a conexão: é normal e não é uma queda.
      if (code === WS_CLOSE.restartRequired && this.restarts < 5) {
        this.restarts += 1;
        this.sock = null;
        try { sock.end(undefined); } catch { /* já fechado */ }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.destroyed) return;
          this.open().catch((err) => this.emit('disconnected', `falha ao reabrir a conexão: ${err.message}`));
        }, 500);
        return;
      }
      if (code === WS_CLOSE.loggedOut) return void this.emit('disconnected', 'LOGOUT');
      if (code === WS_CLOSE.badSession || code === WS_CLOSE.multideviceMismatch) {
        return void this.emit('disconnected', `UNPAIRED (sessão inválida, código ${code})`);
      }
      if (code === WS_CLOSE.connectionReplaced) {
        return void this.emit('disconnected', 'CONFLICT: o WhatsApp foi aberto em outro lugar com esta sessão');
      }
      this.emit('disconnected', `conexão fechada (código ${code || 'desconhecido'}${detail ? `: ${detail}` : ''})`);
    }
  }

  // ---------------------------------------------------------------- recebimento
  onMessages(sock, event) {
    if (sock !== this.sock || this.destroyed) return;
    if (!event || event.type !== 'notify') return;      // 'append' = histórico/sincronização: ignora
    for (const raw of event.messages || []) {
      try {
        if (!raw || !raw.message || !raw.key || raw.key.remoteJid === 'status@broadcast') continue;
        const wrapped = this.wrap(raw);
        if (wrapped.hasMedia) this.remember(wrapped);
        this.emit('message', wrapped);
      } catch (err) {
        console.error(`[${this.clientId}] Erro ao ler mensagem recebida:`, err.message);
      }
    }
  }

  onCalls(sock, calls) {
    if (sock !== this.sock || this.destroyed) return;
    for (const call of calls || []) {
      if (call.status !== 'offer') continue;
      this.emit('call', {
        id: call.id,
        from: toWid(call.from),
        isVideo: !!call.isVideo,
        isGroup: !!call.isGroup
      });
    }
  }

  remember(wrapped) {
    this.recent.set(wrapped.key.id, wrapped);
    while (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value);
  }

  /** Converte a mensagem do Baileys para o formato que o resto do sistema já entende (o do whatsapp-web.js). */
  wrap(raw) {
    const key = raw.key;
    const content = unwrap(raw.message);
    const mediaKey = Object.keys(MEDIA_KEYS).find((k) => content[k]);
    const media = mediaKey ? content[mediaKey] : null;

    let type = 'chat';
    if (mediaKey) type = mediaKey === 'audioMessage' && media.ptt ? 'ptt' : MEDIA_KEYS[mediaKey];

    const body = content.conversation
      || (content.extendedTextMessage && content.extendedTextMessage.text)
      || (media && media.caption)
      || '';

    // Número de telefone real quando o contato vem como LID.
    let from = key.remoteJid;
    if (String(from).endsWith('@lid') && key.remoteJidAlt && String(key.remoteJidAlt).endsWith('@s.whatsapp.net')) {
      from = key.remoteJidAlt;
    }
    from = toWid(from);

    const ad = (content.extendedTextMessage && content.extendedTextMessage.contextInfo
      && content.extendedTextMessage.contextInfo.externalAdReply) || null;

    const serialized = `${key.fromMe ? 'true' : 'false'}_${key.remoteJid}_${key.id}`;
    const client = this;
    return {
      raw,
      key,
      from,
      fromMe: !!key.fromMe,
      body,
      type,
      hasMedia: !!media,
      id: { id: key.id, fromMe: !!key.fromMe, remote: key.remoteJid, _serialized: serialized },
      _data: {
        ctwaContext: ad ? { sourceId: ad.sourceId, sourceUrl: ad.sourceUrl, title: ad.title } : null,
        notifyName: raw.pushName || null
      },
      async downloadMedia() {
        if (!media) return null;
        const download = pick(client.lib, 'downloadMediaMessage');
        const buffer = await download(
          raw,
          'buffer',
          {},
          { logger: SILENT, reuploadRequest: client.sock ? client.sock.updateMediaMessage : undefined }
        );
        if (!buffer || !buffer.length) return null;
        return {
          data: Buffer.from(buffer).toString('base64'),
          mimetype: media.mimetype || 'application/octet-stream',
          filename: media.fileName || null
        };
      },
      async getContact() {
        return { pushname: raw.pushName || null, name: raw.pushName || null, id: { _serialized: from } };
      },
      async getChat() {
        return { fetchMessages: async () => [] };
      }
    };
  }

  // ---------------------------------------------------------------- consultas
  async getState() {
    const open = this.sock && this.sock.ws ? this.sock.ws.isOpen : undefined;
    return this.connected && this.sock && open !== false ? 'CONNECTED' : 'DISCONNECTED';
  }

  async getNumberId(digits) {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    const result = await this.sock.onWhatsApp(`${digits}@s.whatsapp.net`);
    const found = Array.isArray(result) ? result.find((r) => r && r.exists) : null;
    if (!found) return null;
    const user = jidUser(found.jid);
    return { user, server: 'c.us', _serialized: `${user}@c.us` };
  }

  async getContactLidAndPhone(ids) {
    const mapping = this.sock && this.sock.signalRepository && this.sock.signalRepository.lidMapping;
    const out = [];
    for (const id of ids || []) {
      const jid = toJid(id);
      try {
        if (String(jid).endsWith('@lid')) {
          const pn = mapping && mapping.getPNForLID ? await mapping.getPNForLID(jid) : null;
          out.push({ lid: id, pn: pn ? toWid(pn) : null });
        } else {
          const lid = mapping && mapping.getLIDForPN ? await mapping.getLIDForPN(jid) : null;
          out.push({ lid: lid || null, pn: id });
        }
      } catch {
        out.push({});
      }
    }
    return out;
  }

  async getMessageById(id) {
    const plain = String(id || '').split('_').pop();
    return this.recent.get(plain) || null;
  }

  // ---------------------------------------------------------------- envio
  buildPayload(content, options = {}) {
    if (typeof content === 'string') return { text: content };
    const buffer = Buffer.from(content.data, 'base64');
    const mime = String(content.mimetype || 'application/octet-stream');
    const caption = options.caption || undefined;
    const base = mime.split(';')[0].trim().toLowerCase();
    if (options.sendMediaAsDocument || (!/^(image|video|audio)\//.test(base))) {
      return { document: buffer, mimetype: base, fileName: content.filename || 'arquivo', caption };
    }
    if (base.startsWith('image/')) return { image: buffer, caption, mimetype: base };
    if (base.startsWith('video/')) return { video: buffer, caption, mimetype: base };
    // áudio: mensagem de voz (balãozinho com onda) ou arquivo de áudio
    return options.sendAudioAsVoice
      ? { audio: buffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' }
      : { audio: buffer, mimetype: mime };
  }

  async sendMessage(chatId, content, options = {}) {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected (sessão desconectada)');
    const sent = await this.sock.sendMessage(toJid(chatId), this.buildPayload(content, options));
    const key = (sent && sent.key) || {};
    return {
      id: { id: key.id, fromMe: true, remote: key.remoteJid, _serialized: `true_${key.remoteJid}_${key.id}` },
      key
    };
  }

  // ---------------------------------------------------------------- encerramento
  /** Fecha a conexão SEM desvincular o aparelho (as credenciais continuam no disco). */
  async destroy() {
    this.destroyed = true;
    this.connected = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const sock = this.sock;
    this.sock = null;
    this.recent.clear();
    if (sock) {
      try { sock.ev.removeAllListeners('connection.update'); } catch { /* ok */ }
      try { sock.ev.removeAllListeners('messages.upsert'); } catch { /* ok */ }
      try { sock.ev.removeAllListeners('call'); } catch { /* ok */ }
      try { sock.end(undefined); } catch { /* já fechado */ }
    }
    this.removeAllListeners();
  }
}

module.exports = { BaileysClient, SILENT, toWid, toJid };
