// backend/src/services/sms/ISmsProvider.js
class ISmsProvider {
  /**
   * @param {{ to: string, from: string, body: string }} params
   */
  async sendSms(params) {
    throw new Error('sendSms não implementado pelo provedor');
  }
}

module.exports = ISmsProvider;