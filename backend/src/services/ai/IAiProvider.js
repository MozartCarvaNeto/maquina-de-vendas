// backend/src/services/ai/IAiProvider.js

/**
 * Contrato que QUALQUER provedor de IA de texto precisa implementar,
 * para atender o chat de WhatsApp de forma automática (bot de qualificação).
 */
class IAiProvider {
  /**
   * @param {string} systemPrompt - instrução da campanha (Campaign.botPrompt)
   * @param {Array<{role: 'user'|'model', text: string}>} history - histórico da conversa
   * @param {string} userMessage - mensagem atual do lead
   * @returns {Promise<string>} - resposta gerada pela IA
   */
  async generateReply(systemPrompt, history, userMessage) {
    throw new Error('generateReply não implementado pelo provedor');
  }

  async validateCredentials() {
    throw new Error('validateCredentials não implementado pelo provedor');
  }
}

module.exports = IAiProvider;