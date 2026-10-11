// backend/src/services/ai/OpenAiProvider.js
const OpenAiCompatibleProvider = require('./OpenAiCompatibleProvider');

class OpenAiProvider extends OpenAiCompatibleProvider {}
OpenAiProvider.providerId = 'openai';
OpenAiProvider.baseUrl = 'https://api.openai.com/v1';
OpenAiProvider.defaultModel = 'gpt-4o-mini';

module.exports = OpenAiProvider;
