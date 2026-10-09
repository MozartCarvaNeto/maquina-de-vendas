// backend/src/services/telephony/ITelephonyProvider.js

/**
 * Contrato que QUALQUER provedor de telefonia precisa implementar.
 * Isso garante que trocar de operadora (Twilio, Zenvia, Vonage, etc.)
 * não exija mudar nada fora da pasta /telephony.
 */
// backend/src/services/telephony/ITelephonyProvider.js

class ITelephonyProvider {
  async startCall(params) {
    throw new Error('startCall não implementado pelo provedor');
  }

  async hangupCall(params) {
    throw new Error('hangupCall não implementado pelo provedor');
  }

  async validateCredentials() {
    throw new Error('validateCredentials não implementado pelo provedor');
  }

  /**
   * Une a ligação do lead (já atendida) com uma nova ligação para o vendedor,
   * usando uma sala de conferência. Implementado pela Fase 5 (Discador).
   * @param {{ providerCallId: string, agentPhoneNumber: string, conferenceRoomName: string, statusCallbackUrl: string }} params
   * @returns {Promise<{ agentCallSid: string }>}
   */
  async bridgeToAgent(params) {
    throw new Error('bridgeToAgent não implementado pelo provedor');
  }
}

module.exports = ITelephonyProvider;