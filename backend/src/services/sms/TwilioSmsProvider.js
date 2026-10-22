// backend/src/services/sms/TwilioSmsProvider.js
const twilio = require('twilio');
const ISmsProvider = require('./ISmsProvider');
const { toE164BR } = require('../../utils/phone');

const SMS_ERRORS = {
  20003: 'Falha de autenticação na Twilio: confira o Account SID e o Auth Token (Configurações > Telefonia).',
  21211: 'Número de destino inválido para a Twilio.',
  21214: 'Número de destino não pode receber SMS.',
  21408: 'Sua conta Twilio não tem permissão para enviar SMS ao Brasil. Ative em Twilio Console > Messaging > Settings > Geo permissions e marque Brazil.',
  21606: 'O número de origem (remetente) não pode enviar SMS: não é seu na Twilio ou não tem SMS habilitado. Defina um remetente com SMS em Configurações > SMS.',
  21608: 'Conta Twilio de teste (Trial): só envia SMS para números verificados em Console > Phone Numbers > Verified Caller IDs. Faça o upgrade da conta ou verifique o número.',
  21610: 'O destinatário bloqueou o recebimento de SMS deste número (respondeu STOP).',
  21611: 'O remetente atingiu o limite de fila de envio. Aguarde e tente novamente.',
  21612: 'A Twilio não consegue enviar deste remetente para este destino (país/operadora não suportados pelo número de origem).',
  21614: 'O destinatário não é um celular válido para receber SMS.',
  21617: 'A mensagem é longa demais para SMS.',
  21660: 'O número/ID de remetente não pertence à sua conta Twilio.',
  30003: 'Celular desligado ou fora de área.',
  30005: 'Número de destino desconhecido ou inexistente.',
  30006: 'Número fixo ou operadora não aceita SMS.',
  30007: 'A operadora bloqueou a mensagem como spam/filtro.',
  30008: 'Falha desconhecida da operadora na entrega.',
  63007: 'O remetente de WhatsApp não está configurado.'
};

// Erros que valem para a CONTA inteira (de nada adianta tentar o próximo lead): o disparo é pausado.
const CONFIG_CODES = [20003, 21408, 21606, 21608, 21660, 21611];

class TwilioSmsProvider extends ISmsProvider {
  /**
   * @param {{accountSid, authToken}} credentials
   * @param {{sender?: string}} options  sender = número SMS (+1…), ID alfanumérico ou Messaging Service (MG…)
   */
  constructor(credentials, options = {}) {
    super();
    this.client = twilio(credentials.accountSid, credentials.authToken);
    this.sender = options.sender || null;
  }

  translateError(error) {
    const known = SMS_ERRORS[error.code];
    const err = new Error(known || `Erro da Twilio${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    err.twilioCode = error.code;
    err.configProblem = CONFIG_CODES.includes(error.code);
    return err;
  }

  /** @param {{to:string, from?:string, body:string}} params  `from` sobrepõe o remetente padrão */
  async sendSms({ to, from, body }) {
    const destination = toE164BR(to);
    if (!destination) {
      const err = new Error(`Telefone inválido: "${to}"`);
      throw err;
    }
    const sender = from || this.sender;
    if (!sender) {
      const err = new Error('Nenhum remetente de SMS configurado. Defina em Configurações > SMS (um número com SMS da Twilio).');
      err.configProblem = true;
      throw err;
    }
    const params = { to: destination, body };
    if (/^MG[0-9a-f]{32}$/i.test(sender)) params.messagingServiceSid = sender;
    else params.from = sender;

    try {
      const message = await this.client.messages.create(params);
      return { providerMessageId: message.sid };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async validateCredentials() {
    try {
      await this.client.api.accounts(this.client.accountSid).fetch();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: this.translateError(error).message };
    }
  }
}

module.exports = TwilioSmsProvider;
