// backend/src/services/ai/AnthropicProvider.js  (Claude)
const axios = require('axios');
const IAiProvider = require('./IAiProvider');

class AnthropicProvider extends IAiProvider {
  constructor(credentials = {}) {
    super();
    this.apiKey = credentials.apiKey;
    this.model = credentials.model || 'claude-haiku-4-5';
  }

  async generateReply(systemPrompt, history, userMessage) {
    // A API do Claude exige que a conversa comece com "user" e alterne os papéis.
    const turns = [...history.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })), { role: 'user', content: userMessage }];
    const messages = [];
    for (const turn of turns) {
      const last = messages[messages.length - 1];
      if (last && last.role === turn.role) last.content += `\n${turn.content}`;
      else messages.push({ ...turn });
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();

    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: this.model, max_tokens: 500, temperature: 0.6, system: systemPrompt, messages },
      {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 25000
      }
    );

    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text || 'Desculpe, não consegui entender. Um atendente vai te responder em breve.';
  }

  async validateCredentials() {
    try {
      await this.generateReply('Você é um teste de validação. Responda apenas "ok".', [], 'oi');
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.response?.data?.error?.message || error.message };
    }
  }
}

module.exports = AnthropicProvider;
