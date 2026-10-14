// backend/src/services/telephony/JambonzProvider.js
//
// Jambonz: plataforma aberta de voz que se liga ao SEU tronco SIP (Vozio, Voiicr, Avoip, Vivo Empresas...)
// — é o caminho para ligações nacionais com minutos ilimitados do tronco, sem pagar por minuto à Twilio.
// Pode ser a nuvem jambonz.cloud ou um Jambonz instalado no seu servidor.
// Usado só nas ligações da IA — o discador manual com vendedor continua na Twilio.
//
// Credenciais: apiKey (token da API), accountSid, baseUrl (padrão https://api.jambonz.cloud)
// e, opcionalmente, applicationSid.
const ITelephonyProvider = require('./ITelephonyProvider');

class JambonzProvider extends ITelephonyProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.accountSid = credentials.accountSid;
    this.applicationSid = credentials.applicationSid || '';
    this.baseUrl = String(credentials.baseUrl || 'https://api.jambonz.cloud').replace(/\/$/, '');
    this.providerName = 'jambonz';
    this.dialect = 'jambonz';
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.baseUrl}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(`Jambonz: ${data?.msg || data?.message || `HTTP ${response.status}`}`);
      err.status = response.status === 401 || response.status === 403 ? 400 : 502;
      throw err;
    }
    return data;
  }

  async startCall({ to, from, statusCallbackUrl, answerUrl, ringTimeoutSeconds, timeLimitSeconds }) {
    const body = {
      from: String(from).replace(/^\+/, ''),
      to: { type: 'phone', number: to },
      call_hook: { url: answerUrl, method: 'POST' },
      call_status_hook: { url: statusCallbackUrl, method: 'POST' }
    };
    if (this.applicationSid) body.application_sid = this.applicationSid;
    if (ringTimeoutSeconds) body.timeout = ringTimeoutSeconds;
    if (timeLimitSeconds) body.timeLimit = timeLimitSeconds;
    const data = await this.request(`/Accounts/${encodeURIComponent(this.accountSid)}/Calls`, { method: 'POST', body });
    return { providerCallId: data.sid || data.call_sid || null, status: 'queued' };
  }

  async hangupCall({ providerCallId }) {
    await this.request(`/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(providerCallId)}`, {
      method: 'PUT',
      body: { call_status: 'completed' }
    });
    return { success: true };
  }

  async validateCredentials() {
    try {
      await this.request(`/Accounts/${encodeURIComponent(this.accountSid)}/Calls`);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: `${error.message}. Confira a chave, o Account SID e o endereço da API.` };
    }
  }

  async bridgeToAgent() {
    const err = new Error('O discador manual com vendedor continua usando a Twilio; o Jambonz está configurado só para as ligações da IA.');
    err.status = 400;
    throw err;
  }
}

module.exports = JambonzProvider;
