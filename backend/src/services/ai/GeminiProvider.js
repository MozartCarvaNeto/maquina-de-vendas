// backend/src/services/ai/GeminiProvider.js
const axios = require('axios');
const IAiProvider = require('./IAiProvider');

class GeminiProvider extends IAiProvider {
  constructor(credentials) {
    super();
    this.apiKey = credentials.apiKey;
    this.model = credentials.model || 'gemini-1.5-flash';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  async generateReply(systemPrompt, history, userMessage) {
    const contents = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: userMessage }] }
    ];

    const { data } = await axios.post(
      `${this.baseUrl}?key=${this.apiKey}`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.6, maxOutputTokens: 400 }
      },
      { timeout: 20000 }
    );

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
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

module.exports = GeminiProvider;