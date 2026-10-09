// backend/src/services/email/IEmailProvider.js
class IEmailProvider {
  /**
   * @param {{ to: string, subject: string, html: string, attachments?: Array<{ filename: string, path: string }>, leadId?: string, broadcastCampaignId?: string }} params
   *   leadId/broadcastCampaignId são opcionais e só usados pelo provedor
   *   "native" (para registrar abertura/clique por lead/disparo) — os
   *   demais provedores podem ignorá-los.
   */
  async sendEmail(params) {
    throw new Error('sendEmail não implementado pelo provedor');
  }

  async validateCredentials() {
    throw new Error('validateCredentials não implementado pelo provedor');
  }
}

module.exports = IEmailProvider;