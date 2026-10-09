// backend/src/services/sms/TwilioSmsProvider.js
const twilio = require('twilio');
const ISmsProvider = require('./ISmsProvider');

/**
 * Reaproveita as MESMAS credenciais de telefonia (accountSid/authToken)
 * já configuradas em Configurações > Telefonia — não exige tela nova.
 */
class TwilioSmsProvider extends ISmsProvider {
  constructor(credentials) {
    super();
    this.client = twilio(credentials.accountSid, credentials.authToken);
  }

  async sendSms({ to, from, body }) {
    const message = await this.client.messages.create({ to, from, body });
    return { providerMessageId: message.sid };
  }
}

module.exports = TwilioSmsProvider;