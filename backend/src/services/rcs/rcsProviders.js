// backend/src/services/rcs/rcsProviders.js
//
// Provedores de RCS (Rich Communication Services). Cada um recebe a MESMA mensagem "neutra":
//   { to, text, title, imageUrl, buttons: [{type:'url'|'call', label, value}], suggestions: ['Sim','Não'], fallbackText }
// e converte para o formato do provedor.
//  - TwilioRcsProvider : RCS pela Twilio (Messaging Service com remetente RCS; fallback SMS/MMS automático).
//  - CustomHttpRcsProvider : qualquer empresa (Zenvia, Infobip, Sinch, Pontaltech, Take Blip...) por API HTTP/JSON,
//    com modelo de corpo editável na tela de Configurações.
const crypto = require('crypto');
const axios = require('axios');
const { toE164BR } = require('../../utils/phone');

// --- utilidades de texto -----------------------------------------------------------------------------------------
/** RCS não aceita HTML: remove as marcas e mantém o texto/quebras de linha. */
function htmlToRcsText(input) {
  return String(input || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanButtons(buttons) {
  return (Array.isArray(buttons) ? buttons : [])
    .map((b) => ({
      type: b && b.type === 'call' ? 'call' : 'url',
      label: String((b && b.label) || '').trim().slice(0, 25),
      value: String((b && b.value) || '').trim()
    }))
    .filter((b) => b.label && b.value)
    .slice(0, 4);
}

function cleanSuggestions(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s || '').trim().slice(0, 25))
    .filter(Boolean)
    .slice(0, 4);
}

function normalizePhoneForCall(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${toE164BR(digits)?.replace(/^\+/, '') || digits}`;
}

// --- Twilio ------------------------------------------------------------------------------------------------------
const twilioContentCache = new Map(); // hash da estrutura -> contentSid (HX...)

class TwilioRcsProvider {
  /**
   * @param {{accountSid, authToken}} credentials
   * @param {{sender: string, fallbackFrom?: string, disableFallback?: boolean}} options
   *   sender = Messaging Service (MG…, recomendado: tem fallback automático) ou remetente RCS (rcs:nome_do_agente).
   */
  constructor(credentials, options = {}) {
    this.name = 'twilio';
    this.credentials = credentials;
    this.sender = options.sender || null;
    this.fallbackFrom = options.fallbackFrom || null;
    this.disableFallback = Boolean(options.disableFallback);
    this.nativeFallback = /^MG[0-9a-f]{32}$/i.test(this.sender || '') && !this.disableFallback;
  }

  get auth() {
    return { username: this.credentials.accountSid, password: this.credentials.authToken };
  }

  translateError(error) {
    const data = error.response?.data || {};
    const code = data.code || error.code;
    const message = data.message || error.message;
    let text = `Erro da Twilio${code ? ` (${code})` : ''}: ${message}`;
    if (error.response?.status === 401 || code === 20003) {
      text = 'Falha de autenticação na Twilio: confira o Account SID e o Auth Token (Configurações > Telefonia).';
    }
    const err = new Error(text);
    err.configProblem = error.response?.status === 401 || [20003, 21408, 21606, 21608, 21660, 21611].includes(Number(code));
    err.notRcsCapable = /rcs|capab/i.test(String(message)) && !err.configProblem;
    return err;
  }

  async ensureContent({ title, text, imageUrl, buttons, suggestions }) {
    const actions = [
      ...buttons.map((b) =>
        b.type === 'call'
          ? { type: 'PHONE_NUMBER', title: b.label, phone: normalizePhoneForCall(b.value) }
          : { type: 'URL', title: b.label, url: b.value }
      ),
      ...suggestions.map((s) => ({ type: 'QUICK_REPLY', title: s, id: crypto.createHash('md5').update(s).digest('hex').slice(0, 8) }))
    ];
    const card = { title: '{{1}}', subtitle: '{{2}}', actions };
    if (imageUrl) card.media = [imageUrl];
    const key = crypto.createHash('sha1').update(JSON.stringify(card)).digest('hex');
    if (twilioContentCache.has(key)) return twilioContentCache.get(key);

    const { data } = await axios.post(
      'https://content.twilio.com/v1/Content',
      {
        friendly_name: `turbo_rcs_${key.slice(0, 12)}`,
        language: 'pt_BR',
        variables: { 1: 'Titulo', 2: 'Texto' },
        types: { 'twilio/card': card }
      },
      { auth: this.auth, timeout: 20000 }
    );
    twilioContentCache.set(key, data.sid);
    return data.sid;
  }

  async send(msg) {
    const to = toE164BR(msg.to);
    if (!to) throw new Error(`Telefone inválido: "${msg.to}"`);
    if (!this.sender) {
      const e = new Error('Configure o remetente RCS em Configurações > RCS (Messaging Service MG… ou rcs:nome_do_agente).');
      e.configProblem = true;
      throw e;
    }
    const params = new URLSearchParams();
    // Sem fallback (remetente rcs:… ou fallback desligado) o destino precisa do prefixo rcs:.
    params.set('To', this.disableFallback || /^rcs:/i.test(this.sender) ? `rcs:${to}` : to);
    if (/^MG[0-9a-f]{32}$/i.test(this.sender)) params.set('MessagingServiceSid', this.sender);
    else params.set('From', this.sender);
    if (this.fallbackFrom && this.nativeFallback) params.set('FallbackFrom', this.fallbackFrom);

    const richCard = msg.buttons.length > 0 || msg.suggestions.length > 0 || msg.title;
    let usedContent = false;
    if (richCard) {
      try {
        const sid = await this.ensureContent(msg);
        params.set('ContentSid', sid);
        params.set('ContentVariables', JSON.stringify({ 1: msg.title || ' ', 2: msg.text || ' ' }));
        usedContent = true;
      } catch (e) {
        // Não conseguiu criar o modelo de cartão: envia texto + imagem simples (a Twilio monta o cartão).
        console.error(`⚠️ RCS Twilio: não foi possível criar o cartão com botões (${e.response?.data?.message || e.message}). Enviando texto + imagem.`);
      }
    }
    if (!usedContent) {
      params.set('Body', msg.text);
      if (msg.imageUrl) params.set('MediaUrl', msg.imageUrl);
    }

    try {
      const { data } = await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${this.credentials.accountSid}/Messages.json`,
        params.toString(),
        { auth: this.auth, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 25000 }
      );
      return { providerMessageId: data.sid, nativeFallback: this.nativeFallback };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async validate() {
    try {
      await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${this.credentials.accountSid}.json`, { auth: this.auth, timeout: 15000 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: this.translateError(error).message };
    }
  }
}

// --- Outras empresas (API HTTP genérica) -------------------------------------------------------------------------
function jsonEscape(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

/** Preenche o modelo de corpo. {{text}} etc. entram já "escapados" para JSON; {{buttons}}/{{suggestions}} entram como JSON puro. */
function renderBodyTemplate(template, msg, sender) {
  const to = toE164BR(msg.to) || '';
  const map = {
    to,
    toDigits: to.replace(/\D/g, ''),
    sender: sender || '',
    text: msg.text,
    title: msg.title || '',
    imageUrl: msg.imageUrl || '',
    messageId: crypto.randomUUID()
  };
  let out = String(template || '');
  out = out.replace(/\{\{\s*buttons\s*\}\}/g, JSON.stringify(msg.buttons));
  out = out.replace(/\{\{\s*suggestions\s*\}\}/g, JSON.stringify(msg.suggestions));
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in map ? jsonEscape(map[key]) : m));
  return out;
}

class CustomHttpRcsProvider {
  /** @param {{url, authHeader?, apiKey?, sender?, bodyTemplate, method?}} config */
  constructor(config) {
    this.name = 'custom';
    this.config = config;
    this.nativeFallback = false;
  }

  buildRequest(msg) {
    const { url, authHeader, apiKey, sender, bodyTemplate } = this.config;
    const rendered = renderBodyTemplate(bodyTemplate, msg, sender);
    let body;
    try {
      body = JSON.parse(rendered);
    } catch (e) {
      const err = new Error('O modelo de corpo (JSON) em Configurações > RCS ficou inválido depois de preenchido. Revise as aspas e vírgulas.');
      err.configProblem = true;
      throw err;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers[authHeader || 'Authorization'] = apiKey;
    return { url, headers, body };
  }

  async send(msg) {
    if (!toE164BR(msg.to)) throw new Error(`Telefone inválido: "${msg.to}"`);
    const { url, headers, body } = this.buildRequest(msg);
    try {
      const { data } = await axios.post(url, body, { headers, timeout: 25000 });
      const id = data?.id || data?.messageId || data?.messages?.[0]?.messageId || data?.data?.id || null;
      return { providerMessageId: id };
    } catch (error) {
      const status = error.response?.status;
      const detail = JSON.stringify(error.response?.data || error.message).slice(0, 300);
      const err = new Error(`Provedor RCS recusou (${status || 'sem resposta'}): ${detail}`);
      err.configProblem = status === 401 || status === 403;
      if (err.configProblem) err.message = `Provedor RCS recusou as credenciais (${status}). Confira a chave em Configurações > RCS. ${detail}`;
      // Resposta de erro do provedor dizendo que o aparelho não tem RCS: dá para usar o SMS de segurança.
      err.notRcsCapable = Boolean(status && status >= 400 && status < 500 && !err.configProblem && /rcs|capab|not.*(support|reach|enabled)|unreachable|n[aã]o.*suport/i.test(detail));
      throw err;
    }
  }

  async validate() {
    try {
      new URL(this.config.url);
      JSON.parse(renderBodyTemplate(this.config.bodyTemplate, { to: '+5511999998888', text: 'x', buttons: [], suggestions: [] }, this.config.sender));
      return { valid: true };
    } catch (e) {
      return { valid: false, error: 'Endereço (URL) ou modelo de corpo JSON inválido.' };
    }
  }
}

// --- Google RBM (direto, sem agregador) ----------------------------------------------------------------------------
const RBM_HOST = 'https://rcsbusinessmessaging.googleapis.com';
const RBM_SCOPE = 'https://www.googleapis.com/auth/rcsbusinessmessaging';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

class GoogleRbmProvider {
  /** @param {{serviceAccountJson: string, agentId?: string}} config  (JSON da conta de serviço do agente RBM) */
  constructor(config, deps = {}) {
    this.name = 'google_rbm';
    this.nativeFallback = false;
    this.agentId = config.agentId || null;
    this.http = deps.http || axios;
    try {
      this.sa = typeof config.serviceAccountJson === 'string' ? JSON.parse(config.serviceAccountJson) : config.serviceAccountJson;
    } catch (e) {
      this.sa = null;
    }
    this.token = null;
    this.tokenExp = 0;
  }

  assertConfigured() {
    if (!this.sa || !this.sa.client_email || !this.sa.private_key) {
      const e = new Error('Configurações > RCS: cole o arquivo JSON da conta de serviço do seu agente RBM (Google).');
      e.configProblem = true;
      throw e;
    }
  }

  async accessToken() {
    this.assertConfigured();
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now < this.tokenExp - 60) return this.token;
    const uri = this.sa.token_uri || 'https://oauth2.googleapis.com/token';
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: this.sa.client_email, scope: RBM_SCOPE, aud: uri, iat: now, exp: now + 3600 }))}`;
    let sig;
    try {
      sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key);
    } catch (e) {
      const err = new Error('A chave privada do JSON da conta de serviço é inválida.');
      err.configProblem = true;
      throw err;
    }
    try {
      const { data } = await this.http.post(
        uri,
        new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
      );
      this.token = data.access_token;
      this.tokenExp = now + (data.expires_in || 3600);
      return this.token;
    } catch (error) {
      const err = new Error(`O Google recusou a conta de serviço do RCS: ${error.response?.data?.error_description || error.response?.data?.error || error.message}`);
      err.configProblem = true;
      throw err;
    }
  }

  static action(b, i) {
    const postbackData = `btn${i}`;
    if (b.type === 'call') return { action: { text: b.label, postbackData, dialAction: { phoneNumber: normalizePhoneForCall(b.value) } } };
    return { action: { text: b.label, postbackData, openUrlAction: { url: b.value } } };
  }

  /** Mensagem neutra -> corpo da API RBM (texto com respostas rápidas, ou cartão com imagem e botões). */
  static buildContent(msg) {
    const replies = (msg.suggestions || []).map((s, i) => ({ reply: { text: s, postbackData: `rep${i}_${s}`.slice(0, 120) } }));
    const buttons = (msg.buttons || []).map((b, i) => GoogleRbmProvider.action(b, i));
    const text = String(msg.text || '').slice(0, 3072);
    if (!msg.title && !msg.imageUrl) {
      const chips = [...buttons, ...replies].slice(0, 11);
      return { text, ...(chips.length ? { suggestions: chips } : {}) };
    }
    const cardContent = { description: String(msg.text || '').slice(0, 2000) };
    if (msg.title) cardContent.title = String(msg.title).slice(0, 200);
    if (msg.imageUrl) cardContent.media = { height: 'MEDIUM', contentInfo: { fileUrl: msg.imageUrl, forceRefresh: false } };
    if (buttons.length) cardContent.suggestions = buttons.slice(0, 4);
    const content = { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent } } };
    if (replies.length) content.suggestions = replies.slice(0, 11);
    return content;
  }

  async send(msg) {
    const to = toE164BR(msg.to);
    if (!to) throw new Error(`Telefone inválido: "${msg.to}"`);
    const token = await this.accessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const phone = encodeURIComponent(to.startsWith('+') ? to : `+${to}`);
    const agent = this.agentId ? `&agentId=${encodeURIComponent(this.agentId)}` : '';
    // Confere se o aparelho tem RCS (se a checagem falhar por outro motivo, tenta enviar mesmo assim).
    try {
      await this.http.get(`${RBM_HOST}/v1/phones/${phone}/capabilities?requestId=${crypto.randomUUID()}${agent}`, { headers, timeout: 15000 });
    } catch (e) {
      if (e.response?.status === 404) {
        const err = new Error('Este celular não tem RCS ativo.');
        err.notRcsCapable = true;
        throw err;
      }
    }
    const messageId = crypto.randomUUID();
    try {
      const { data } = await this.http.post(
        `${RBM_HOST}/v1/phones/${phone}/agentMessages?messageId=${messageId}${agent}`,
        { contentMessage: GoogleRbmProvider.buildContent(msg) },
        { headers, timeout: 25000 }
      );
      return { providerMessageId: data?.name || messageId };
    } catch (error) {
      const status = error.response?.status;
      const detail = JSON.stringify(error.response?.data?.error?.message || error.response?.data || error.message).slice(0, 300);
      const err = new Error(`Google RCS recusou (${status || 'sem resposta'}): ${detail}`);
      err.configProblem = status === 401 || status === 403;
      if (err.configProblem) err.message = `O Google recusou o agente de RCS (${status}). O agente precisa estar aprovado/lançado e ter a conta de serviço correta. ${detail}`;
      err.notRcsCapable = status === 404;
      throw err;
    }
  }

  async validate() {
    try {
      await this.accessToken();
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}

module.exports = { GoogleRbmProvider, TwilioRcsProvider, CustomHttpRcsProvider, htmlToRcsText, cleanButtons, cleanSuggestions, renderBodyTemplate };
