// backend/src/services/ai/OpenAiCompatibleProvider.js
//
// Base para qualquer serviço que fale o "idioma" da OpenAI (/chat/completions):
// OpenAI, Groq, OpenRouter, DeepSeek, Mistral, xAI (Grok), Together, e também
// qualquer endereço próprio informado pelo cliente (provedor "custom").
const axios = require('axios');
const IAiProvider = require('./IAiProvider');

class OpenAiCompatibleProvider extends IAiProvider {
  constructor(credentials = {}) {
    super();
    this.apiKey = credentials.apiKey;
    this.model = credentials.model || this.constructor.defaultModel;
    this.baseUrl = String(credentials.baseUrl || this.constructor.baseUrl || '').replace(/\/+$/, '');
    this.extraHeaders = this.constructor.extraHeaders || {};
  }

  /** Modelos de raciocínio da OpenAI (o1/o3/gpt-5...) não aceitam temperature/max_tokens. */
  isReasoningModel() {
    return /^(o\d|gpt-5)/i.test(this.model) && this.constructor.providerId === 'openai';
  }

  async generateReply(systemPrompt, history, userMessage) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: userMessage }
    ];

    const body = { model: this.model, messages };
    if (this.isReasoningModel()) {
      body.max_completion_tokens = 1200;
    } else {
      body.temperature = 0.6;
      body.max_tokens = 400;
    }

    const { data } = await axios.post(`${this.baseUrl}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders
      },
      timeout: 25000
    });

    const text = data?.choices?.[0]?.message?.content;
    return (text && String(text).trim()) || 'Desculpe, não consegui entender. Um atendente vai te responder em breve.';
  }

  async validateCredentials() {
    try {
      await this.generateReply('Você é um teste de validação. Responda apenas "ok".', [], 'oi');
      return { valid: true };
    } catch (error) {
      const data = error.response?.data;
      return { valid: false, error: data?.error?.message || data?.message || error.message };
    }
  }
}

module.exports = OpenAiCompatibleProvider;
