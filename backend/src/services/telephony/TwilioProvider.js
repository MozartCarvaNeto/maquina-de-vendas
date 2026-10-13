// backend/src/services/telephony/TwilioProvider.js
const twilio = require('twilio');
const ITelephonyProvider = require('./ITelephonyProvider');

const TWILIO_ERROR_MESSAGES = {
  21219:
    'Este número não está verificado na sua conta Twilio Trial. Verifique-o em Twilio Console → Phone Numbers → Manage → Verified Caller IDs, ou faça upgrade da conta para uma paga.',
  21211: 'Número de telefone inválido. Use o formato internacional, ex: +5511999998888.',
  21214:
    'Este destino não pode ser chamado com sua conta Twilio atual (restrição geográfica). Ative em Twilio Console → Voice → Settings → Geo Permissions.',
  21606: 'O número de origem (From) não pertence à sua conta Twilio ou não está habilitado para chamadas de voz.',
  20003: 'Falha de autenticação com a Twilio — verifique o Account SID e o Auth Token em Configurações.'
};

class TwilioProvider extends ITelephonyProvider {
  constructor(credentials) {
    super();
    this.accountSid = credentials.accountSid;
    this.authToken = credentials.authToken;
    this.client = twilio(this.accountSid, this.authToken);
  }

  translateError(error) {
    return TWILIO_ERROR_MESSAGES[error.code] || `Erro da Twilio: ${error.message}`;
  }

  /**
   * Parâmetros extras (todos opcionais — o discador com vendedor humano
   * continua chamando só com to/from/statusCallbackUrl, como sempre):
   *  - twiml: instruções que rodam assim que o lead atende (usado pela ligação robô)
   *  - ringTimeoutSeconds: quanto tempo deixar tocar antes de desistir
   *  - timeLimitSeconds: duração máxima da ligação (proteção contra custo inesperado)
   *  - recordingStatusCallbackUrl: se informado, grava a ligação inteira
   */
  async startCall({ to, from, statusCallbackUrl, twiml, ringTimeoutSeconds, timeLimitSeconds, recordingStatusCallbackUrl }) {
    try {
      const params = {
        to,
        from,
        twiml: twiml || '<Response><Pause length="600"/></Response>',
        statusCallback: statusCallbackUrl,
        // Valores válidos da Twilio: initiated, ringing, answered e completed. "answered" é o aviso de que a
        // pessoa atendeu (CallStatus=in-progress); sem ele o sistema nunca sabia que a ligação foi atendida.
        // busy/failed/no-answer chegam dentro do evento "completed".
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST'
      };
      if (ringTimeoutSeconds) params.timeout = ringTimeoutSeconds;
      if (timeLimitSeconds) params.timeLimit = timeLimitSeconds;
      if (recordingStatusCallbackUrl) {
        params.record = true;
        params.recordingStatusCallback = recordingStatusCallbackUrl;
        params.recordingStatusCallbackEvent = ['completed'];
      }
      const call = await this.client.calls.create(params);
      return { providerCallId: call.sid, status: call.status };
    } catch (error) {
      const err = new Error(this.translateError(error));
      err.status = 400;
      err.twilioCode = error.code;
      throw err;
    }
  }

  async hangupCall({ providerCallId }) {
    await this.client.calls(providerCallId).update({ status: 'completed' });
    return { success: true };
  }

  async validateCredentials() {
    try {
      await this.client.api.accounts(this.accountSid).fetch();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: this.translateError(error) };
    }
  }

  async bridgeToAgent({
    providerCallId,
    from,
    agentPhoneNumber,
    conferenceRoomName,
    statusCallbackUrl,
    recordingEnabled,
    recordingStatusCallbackUrl
  }) {
    await this.client.calls(providerCallId).update({
      twiml: `<Response><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true">${conferenceRoomName}</Conference></Dial></Response>`
    });

    const recordAttrs = recordingEnabled
      ? ` record="record-from-start" recordingStatusCallback="${recordingStatusCallbackUrl}" recordingStatusCallbackEvent="completed"`
      : '';

    try {
      const agentCall = await this.client.calls.create({
        to: agentPhoneNumber,
        from,
        twiml: `<Response><Say language="pt-BR">Conectando com o lead, aguarde.</Say><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true"${recordAttrs}>${conferenceRoomName}</Conference></Dial></Response>`,
        statusCallback: statusCallbackUrl,
        statusCallbackEvent: ['answered', 'completed'],
        statusCallbackMethod: 'POST'
      });
      return { agentCallSid: agentCall.sid };
    } catch (error) {
      const err = new Error(this.translateError(error));
      err.status = 400;
      err.twilioCode = error.code;
      throw err;
    }
  }
}

module.exports = TwilioProvider;