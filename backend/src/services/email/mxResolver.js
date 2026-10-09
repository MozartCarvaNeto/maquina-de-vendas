// backend/src/services/email/mxResolver.js
const dns = require('dns').promises;

/**
 * Descobre os servidores de e-mail (MX) responsáveis por um domínio,
 * ordenados por prioridade — exatamente o que qualquer servidor de e-mail
 * do mundo (Gmail, Outlook, etc.) faz antes de aceitar entregar uma
 * mensagem. É isto que permite enviar direto para a caixa de entrada,
 * sem passar por um serviço intermediário como Resend ou Brevo.
 */
async function resolveMxHosts(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (records && records.length > 0) {
      return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    }
  } catch (error) {
    if (error.code !== 'ENODATA' && error.code !== 'ENOTFOUND') throw error;
  }

  // RFC 5321 §5.1: se o domínio não tem registro MX, mas responde por A/AAAA,
  // o próprio domínio é o destino (comum em domínios pequenos mal configurados).
  try {
    await dns.resolve4(domain);
    return [domain];
  } catch {
    try {
      await dns.resolve6(domain);
      return [domain];
    } catch {
      return [];
    }
  }
}

module.exports = { resolveMxHosts };