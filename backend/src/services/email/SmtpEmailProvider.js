// backend/src/services/email/SmtpEmailProvider.js
const nodemailer = require('nodemailer');
const IEmailProvider = require('./IEmailProvider');

/**
 * Envia e-mail usando o SMTP da sua própria caixa de e-mail corporativa
 * (Gmail Workspace, Outlook/Microsoft 365, ou o SMTP da sua hospedagem).
 * Não depende de nenhuma plataforma paga de terceiros — é o protocolo
 * padrão de e-mail direto.
 *
 * IMPORTANTE: a maioria dos provedores (Gmail, Outlook) exige uma "senha
 * de aplicativo" em vez da senha normal da conta, por segurança.
 */
class SmtpEmailProvider extends IEmailProvider {
  constructor(credentials) {
    super();
    this.fromEmail = credentials.fromEmail;
    this.fromName = credentials.fromName || 'Turbo Prospect';
    this.transporter = nodemailer.createTransport({
      host: credentials.host,
      port: Number(credentials.port) || 587,
      secure: Number(credentials.port) === 465,
      auth: {
        user: credentials.user,
        pass: credentials.pass
      }
    });
  }

  async sendEmail({ to, subject, html, attachments }) {
    const info = await this.transporter.sendMail({
      from: `${this.fromName} <${this.fromEmail}>`,
      to,
      subject,
      html,
      // nodemailer aceita { filename, path } diretamente — path pode ser
      // um caminho local em disco (é o que broadcastService.js envia).
      attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined
    });
    return { providerMessageId: info.messageId };
  }

  async validateCredentials() {
    try {
      await this.transporter.verify();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

module.exports = SmtpEmailProvider;