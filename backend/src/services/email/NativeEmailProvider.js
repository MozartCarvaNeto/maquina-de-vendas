// backend/src/services/email/NativeEmailProvider.js
//
// Provedor de e-mail nativo: monta, assina (DKIM) e entrega a mensagem
// direto no servidor do destinatário, sem passar por Resend, Brevo,
// Mailchimp ou qualquer outra plataforma paga. Implementa a mesma
// interface (IEmailProvider) que os provedores antigos, então o resto do
// sistema (disparos, etc.) não precisa saber a diferença.
const crypto = require('crypto');
const IEmailProvider = require('./IEmailProvider');
const prisma = require('../../config/db');
const nativeSmtpSender = require('./nativeSmtpSender');
const emailTrackingService = require('./emailTrackingService');
const { resolveMxHosts } = require('./mxResolver');

/** Remove tags HTML de forma simples, só para gerar a versão texto-puro exigida por filtros anti-spam. */
function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class NativeEmailProvider extends IEmailProvider {
  /**
   * @param {object} params
   * @param {string} params.fromEmail
   * @param {string} params.fromName
   * @param {string} params.userId
   * @param {string} params.domain
   * @param {string} params.dkimSelector
   * @param {string} params.dkimPrivateKey
   * @param {string} params.bounceLocalPart
   */
  constructor({ fromEmail, fromName, userId, domain, dkimSelector, dkimPrivateKey, bounceLocalPart, sendingHostname }) {
    super();
    this.fromEmail = fromEmail;
    this.fromName = fromName || 'Turbo Prospect';
    this.userId = userId;
    this.domain = domain;
    this.dkimSelector = dkimSelector;
    this.dkimPrivateKey = dkimPrivateKey;
    this.bounceLocalPart = bounceLocalPart || 'bounce';
    // Nome usado no HELO/EHLO da conexão SMTP. Precisa bater com o PTR (DNS
    // reverso) configurado no IP do servidor, senão Gmail/Outlook desconfiam
    // do remetente (checagem de FCrDNS). Ver emailDomainService.
    this.sendingHostname = sendingHostname || domain;
  }

  async sendEmail({ to, subject, html, attachments, leadId = null, broadcastCampaignId = null }) {
    const toEmail = String(to || '').trim().toLowerCase();

    if (await emailTrackingService.isSuppressed(this.userId, toEmail)) {
      const err = new Error(
        `O e-mail ${toEmail} está na lista de supressão (já retornou erro definitivo, foi denunciado como spam, ou pediu descadastro antes) e não será enviado de novo.`
      );
      err.status = 422;
      err.classification = 'suprimido';
      throw err;
    }

    const trackingToken = emailTrackingService.generateTrackingToken();
    const messageId = `<${crypto.randomUUID()}@${this.domain}>`;
    const unsubscribeUrl = emailTrackingService.buildUnsubscribeUrl(trackingToken);

    let finalHtml = emailTrackingService.rewriteLinksForClickTracking(html, trackingToken);
    finalHtml += `
      <div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e5e5;font-family:sans-serif;font-size:11px;color:#999;">
        Não quer mais receber estes e-mails? <a href="${unsubscribeUrl}" style="color:#999;">Cancelar inscrição</a>.
      </div>`;
    finalHtml += emailTrackingService.buildOpenPixelTag(trackingToken);

    // O "Return-Path" (para onde bounces são endereçados) é diferente do
    // "From" que aparece pro destinatário — inclui o token na parte local
    // do endereço para permitir, no futuro, casar um bounce recebido de
    // volta com este envio específico (técnica conhecida como VERP).
    const bounceAddress = `${this.bounceLocalPart}+${trackingToken}@${this.domain}`;

    const mailOptions = {
      from: `${this.fromName} <${this.fromEmail}>`,
      to: toEmail,
      subject,
      html: finalHtml,
      text: htmlToPlainText(html),
      messageId,
      envelope: { from: bounceAddress, to: [toEmail] },
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      },
      attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined
    };

    const rawMessage = await nativeSmtpSender.buildRawMessage(mailOptions);
    const signedMessage = await nativeSmtpSender.signWithDkim(rawMessage, {
      domainName: this.domain,
      keySelector: this.dkimSelector,
      privateKey: this.dkimPrivateKey
    });

    try {
      const { mxHost, smtpResponse } = await nativeSmtpSender.deliverToMx({
        fromEmail: bounceAddress,
        toEmail,
        rawMessage: signedMessage,
        heloName: this.sendingHostname
      });

      await prisma.emailMessage.create({
        data: {
          userId: this.userId,
          broadcastCampaignId,
          leadId,
          toEmail,
          fromEmail: this.fromEmail,
          subject,
          messageId,
          trackingToken,
          status: 'enviado',
          smtpResponse,
          mxHost,
          attempts: 1
        }
      });

      return { providerMessageId: messageId };
    } catch (error) {
      const classification = error.classification === 'bounce' ? 'falhou' : 'adiado';

      await prisma.emailMessage.create({
        data: {
          userId: this.userId,
          broadcastCampaignId,
          leadId,
          toEmail,
          fromEmail: this.fromEmail,
          subject,
          messageId,
          trackingToken,
          status: classification,
          smtpResponse: String(error.response || error.message || '').slice(0, 500),
          mxHost: error.mxHost || null,
          attempts: 1,
          bouncedAt: classification === 'falhou' ? new Date() : null
        }
      });

      if (classification === 'falhou') {
        await prisma.emailSuppression
          .upsert({
            where: { userId_email: { userId: this.userId, email: toEmail } },
            update: { reason: 'bounce' },
            create: { userId: this.userId, email: toEmail, reason: 'bounce' }
          })
          .catch(() => {
            // não bloqueia o envio por causa da supressão
          });
      }

      const friendly = new Error(
        classification === 'falhou'
          ? `O servidor de e-mail de ${toEmail} recusou definitivamente a mensagem: ${error.message}`
          : `Falha temporária ao entregar para ${toEmail}: ${error.message}`
      );
      friendly.status = 502;
      friendly.isConnectionError = classification === 'adiado';
      throw friendly;
    }
  }

  /**
   * Não existe "API" para validar como no Resend — em vez disso, confirmamos
   * que a resolução de DNS (essencial para achar os servidores MX de
   * destino) está funcionando neste servidor.
   */
  async validateCredentials() {
    try {
      const hosts = await resolveMxHosts('gmail.com');
      if (!hosts.length) {
        return { valid: false, error: 'Não foi possível resolver DNS neste servidor (teste com gmail.com falhou).' };
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

module.exports = NativeEmailProvider;