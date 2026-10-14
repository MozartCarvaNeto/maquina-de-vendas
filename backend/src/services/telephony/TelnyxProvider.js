// backend/src/services/telephony/TelnyxProvider.js
//
// Telnyx (TeXML). A conversa da IA continua a mesma: o sistema monta o TwiML e a Telnyx entende quase igual
// (TeXML). Usado só nas ligações da IA — o discador manual com vendedor continua na Twilio.
//
// Credenciais: apiKey (chave da API v2), applicationSid (ID do "TeXML Application") e,
// opcionalmente, accountSid e sttEngine ("deepgram" ou "google").
const ITelephonyProvider = require('./ITelephonyProvider');

const API = 'https://api.telnyx.com/v2';

class TelnyxProvider extends ITelephonyProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.applicationSid = credentials.applicationSid;
    this.accountSid = credentials.accountSid || '';
    this.sttEngine = credentials.sttEngine || 'deepgram';
    this.providerName = 'telnyx';
    this.dialect = 'texml';
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || data?.message || `HTTP ${response.status}`;
      const err = new Error(`Telnyx: ${detail}`);
      err.status = response.status === 401 || response.status === 403 ? 400 : 502;
      throw err;
    }
    return data;
  }

  /**
   * answerUrl: endereço que a Telnyx consulta quando o cliente atende (devolve a abertura da IA).
   * Parâmetros extras iguais aos da Twilio (tempo de toque, duração máxima, gravação).
   */
  async startCall({ to, from, statusCallbackUrl, answerUrl, ringTimeoutSeconds, timeLimitSeconds, recordingStatusCallbackUrl }) {
    const body = {
      ApplicationSid: this.applicationSid,
      To: to,
      From: from,
      Url: answerUrl,
      UrlMethod: 'POST',
      StatusCallback: statusCallbackUrl,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed'
    };
    if (ringTimeoutSeconds) body.Timeout = ringTimeoutSeconds;
    if (timeLimitSeconds) body.TimeLimit = timeLimitSeconds;
    if (recordingStatusCallbackUrl) {
      body.Record = true;
      body.RecordingStatusCallback = recordingStatusCallbackUrl;
    }
    const path = this.accountSid
      ? `/texml/Accounts/${encodeURIComponent(this.accountSid)}/Calls`
      : `/texml/calls/${encodeURIComponent(this.applicationSid)}`;
    const data = await this.request(path, { method: 'POST', body });
    const result = data?.data || data;
    const providerCallId = result.call_sid || result.CallSid || result.sid || result.call_control_id || null;
    return { providerCallId, status: result.status || 'queued' };
  }

  async hangupCall({ providerCallId }) {
    if (!this.accountSid) return { success: false };
    await this.request(`/texml/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(providerCallId)}`, {
      method: 'POST',
      body: { Status: 'completed' }
    });
    return { success: true };
  }

  async validateCredentials() {
    try {
      await this.request('/balance');
    } catch (error) {
      return { valid: false, error: `Chave da Telnyx recusada ou sem acesso. ${error.message}` };
    }
    try {
      await this.request(`/texml_applications/${encodeURIComponent(this.applicationSid)}`);
    } catch (error) {
      return { valid: false, error: `A chave está certa, mas o TeXML Application "${this.applicationSid}" não foi encontrado. ${error.message}` };
    }
    return { valid: true };
  }

  async bridgeToAgent() {
    const err = new Error('O discador manual com vendedor continua usando a Twilio; a Telnyx está configurada só para as ligações da IA.');
    err.status = 400;
    throw err;
  }
}

module.exports = TelnyxProvider;
