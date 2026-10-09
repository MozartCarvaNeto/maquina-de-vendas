// backend/src/services/email/ResendEmailProvider.js
const axios = require('axios');
const fs = require('fs');
const IEmailProvider = require('./IEmailProvider');

class ResendEmailProvider extends IEmailProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.fromEmail = credentials.fromEmail;
    this.fromName = credentials.fromName || 'Máquina de Vendas';
  }

  async sendEmail({ to, subject, html, attachments }) {
    // A API do Resend espera os anexos em base64 (campo "content"), não um
    // caminho de arquivo — por isso lemos cada arquivo em disco aqui.
    const resendAttachments = (attachments || [])
      .map((a) => {
        try {
          const content = fs.readFileSync(a.path).toString('base64');
          return { filename: a.filename, content };
        } catch (err) {
          console.error(`Não foi possível ler o anexo "${a.filename}" para envio por e-mail:`, err.message);
          return null;
        }
      })
      .filter(Boolean);

    const { data } = await axios.post(
      'https://api.resend.com/emails',
      {
        from: `${this.fromName} <${this.fromEmail}>`,
        to: [to],
        subject,
        html,
        ...(resendAttachments.length ? { attachments: resendAttachments } : {})
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return { providerMessageId: data.id };
  }

  async validateCredentials() {
    try {
      await axios.get('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.response?.data?.message || error.message };
    }
  }
}

module.exports = ResendEmailProvider;