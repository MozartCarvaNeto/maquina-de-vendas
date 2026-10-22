// backend/src/services/email/TwilioEmailProvider.js
//
// E-mail pela API nova da Twilio ("Try out Email" no console): POST https://comms.twilio.com/v1/Emails
// com as MESMAS chaves da Twilio (Account SID + Auth Token, autenticação Basic) — não usa chave "SG." do SendGrid.
// O remetente (from) precisa estar verificado/autenticado na Twilio (Console > Email > Senders/Domains).
const axios = require('axios');
const IEmailProvider = require('./IEmailProvider');

const API = 'https://comms.twilio.com/v1/Emails';

function twilioEmailError(error) {
  const data = error.response?.data;
  const status = error.response?.status;
  if (status === 401) return 'Chaves da Twilio recusadas (Account SID / Auth Token). Confira em Configurações > Telefonia.';
  if (data) {
    const msg = data.message || data.detail || data.error || data.title || (Array.isArray(data.errors) ? data.errors.map((e) => e.message || e).join(' | ') : null);
    if (msg) return `${msg}${status ? ` (HTTP ${status})` : ''}`;
    return `HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`;
  }
  return error.message;
}

class TwilioEmailProvider extends IEmailProvider {
  constructor(credentials) {
    super();
    this.accountSid = credentials.accountSid;
    this.authToken = credentials.authToken;
    this.fromEmail = credentials.fromEmail;
    this.fromName = credentials.fromName || 'Turbo Prospect';
  }

  get auth() {
    return { username: this.accountSid, password: this.authToken };
  }

  async sendEmail({ to, subject, html, attachments }) {
    if (attachments && attachments.length > 0) {
      throw new Error('O e-mail da Twilio (comms) não aceita anexos. Para disparos com anexo use SMTP, Resend ou SendGrid.');
    }
    if (!this.fromEmail) throw new Error('Informe o e-mail remetente em Configurações > E-mail.');
    // Texto simples gerado do HTML, para clientes de e-mail sem HTML.
    const text = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    try {
      const response = await axios.post(
        API,
        {
          from: { address: this.fromEmail, name: this.fromName },
          to: [{ address: to }],
          content: { subject, html, text }
        },
        { auth: this.auth, headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      return { providerMessageId: response.data?.operationId || null };
    } catch (error) {
      throw new Error(`Twilio e-mail: ${twilioEmailError(error)}`);
    }
  }

  async validateCredentials() {
    try {
      // Lista e-mails (leitura): só para provar que as chaves são aceitas por esta API.
      await axios.get(API, { auth: this.auth, timeout: 15000, params: { pageSize: 1 } });
      return { valid: true };
    } catch (error) {
      if (error.response && error.response.status !== 401 && error.response.status !== 403) {
        // A API respondeu (ex.: 400 por parâmetro): as chaves foram aceitas.
        return { valid: true };
      }
      return { valid: false, error: twilioEmailError(error) };
    }
  }
}

module.exports = TwilioEmailProvider;
