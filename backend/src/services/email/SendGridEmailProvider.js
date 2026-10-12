// backend/src/services/email/SendGridEmailProvider.js
//
// E-mail pela Twilio SendGrid (o serviço de e-mail da Twilio, com franquia grátis).
// ATENÇÃO: usa uma chave PRÓPRIA do SendGrid (começa com "SG."), criada em
// app.sendgrid.com > Settings > API Keys — não é o Account SID / Auth Token da Twilio.
// O e-mail do remetente precisa estar verificado no SendGrid (Sender Authentication).
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const IEmailProvider = require('./IEmailProvider');

const API = 'https://api.sendgrid.com/v3';

function sendGridError(error) {
  const list = error.response?.data?.errors;
  if (Array.isArray(list) && list.length > 0) {
    return list.map((e) => e.message).filter(Boolean).join(' | ');
  }
  return error.message;
}

class SendGridEmailProvider extends IEmailProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.fromEmail = credentials.fromEmail;
    this.fromName = credentials.fromName || 'Turbo Prospect';
  }

  async sendEmail({ to, subject, html, attachments }) {
    const sgAttachments = (attachments || [])
      .map((a) => {
        try {
          return {
            content: fs.readFileSync(a.path).toString('base64'),
            filename: a.filename || path.basename(a.path),
            disposition: 'attachment'
          };
        } catch (err) {
          console.error(`Não foi possível ler o anexo "${a.filename}" para envio por e-mail:`, err.message);
          return null;
        }
      })
      .filter(Boolean);

    try {
      const response = await axios.post(
        `${API}/mail/send`,
        {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: this.fromEmail, name: this.fromName },
          subject,
          content: [{ type: 'text/html', value: html }],
          ...(sgAttachments.length ? { attachments: sgAttachments } : {})
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );
      // O SendGrid responde 202 sem corpo; o id da mensagem vem no cabeçalho.
      return { providerMessageId: response.headers?.['x-message-id'] || null };
    } catch (error) {
      throw new Error(`SendGrid: ${sendGridError(error)}`);
    }
  }

  async validateCredentials() {
    try {
      const { data } = await axios.get(`${API}/scopes`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
      if (scopes.length > 0 && !scopes.includes('mail.send')) {
        return {
          valid: false,
          error: 'A chave é válida, mas não tem permissão de envio (Mail Send). Crie outra com "Full Access" ou marque Mail Send.'
        };
      }
      return { valid: true };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return { valid: false, error: 'Chave do SendGrid recusada. Use a API Key do SendGrid (começa com "SG."), não o SID/Token da Twilio.' };
      }
      return { valid: false, error: sendGridError(error) };
    }
  }
}

module.exports = SendGridEmailProvider;
