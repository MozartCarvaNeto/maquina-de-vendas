// backend/src/services/sms/NativeSmsProvider.js
// SMS pelo gateway nativo (fornecedores SMPP cadastrados em "Gateway de telecom"). Mesma interface da Twilio.
const ISmsProvider = require('./ISmsProvider');
const gateway = require('../smsgw/gateway');

class NativeSmsProvider extends ISmsProvider {
  constructor(userId, { sender } = {}) {
    super();
    this.name = 'native';
    this.userId = userId;
    // O remetente de verdade vem do cadastro de cada fornecedor (troca junto com o fornecedor).
    this.sender = sender || 'SMS';
  }

  async sendSms({ to, body }) {
    const result = await gateway.sendAndWait({ userId: this.userId, to, body, source: 'broadcast' });
    return { sid: (result.providerIds || [])[0] || null };
  }
}

module.exports = NativeSmsProvider;
