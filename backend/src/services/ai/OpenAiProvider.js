// backend/src/services/ai/OpenAiProvider.js
const axios = require('axios');
const IAiProvider = require('./IAiProvider');

class OpenAiProvider extends IAiProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.model = credentials.model || 'gpt-4o-mini';
  }

  async generateReply(systemPrompt, history, userMessage) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: userMessage }
    ];

    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.model,
        messages,
        temperature: 0.6,
        max_tokens: 400
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const text = data?.choices?.[0]?.message?.content;
    return text || 'Desculpe, não consegui entender. Um atendente vai te responder em breve.';
  }

  async validateCredentials() {
    try {
      await this.generateReply('Você é um teste de validação.', [], 'oi');
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.response?.data?.error?.message || error.message };
    }
  }
}

module.exports = OpenAiProvider;