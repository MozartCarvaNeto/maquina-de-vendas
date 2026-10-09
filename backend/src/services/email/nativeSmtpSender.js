// backend/src/services/email/nativeSmtpSender.js
//
// Este é o motor de entrega direta de e-mail: monta a mensagem (MIME),
// assina com DKIM e conecta-se diretamente ao servidor de e-mail (MX) do
// destinatário para entregar — o mesmo caminho que Gmail, Outlook, Mailchimp
// ou Brevo usam por trás dos panos. Não depende de nenhuma API paga de
// terceiros.
//
// IMPORTANTE (leia antes de usar em produção — nenhum código resolve isto):
// para o Gmail/Outlook/Yahoo aceitarem os e-mails na caixa de entrada (em
// vez de rejeitar ou jogar em spam), o SERVIDOR que roda este backend
// precisa, além do código funcionar:
//   1) ter a porta 25 de SAÍDA liberada (a maioria das nuvens — AWS, GCP,
//      Azure, DigitalOcean — bloqueia por padrão e exige pedido especial);
//   2) ter um registro de PTR/DNS reverso configurado para o IP do servidor
//      apontando para o domínio de envio (isso é feito no provedor de
//      hospedagem, não no código);
//   3) o IP do servidor não estar em nenhuma lista de bloqueio (blocklist)
//      — IPs de nuvem "genéricos" costumam já nascer malvistos;
//   4) aquecer o volume aos poucos (poucas dezenas/dia no início, subindo
//      gradualmente), porque um IP novo enviando milhares de e-mails de uma
//      vez é o padrão clássico de spam.
// Sem os itens acima, o motor entrega tecnicamente certo, mas os e-mails
// podem ser recusados ou parar na caixa de spam.

const { Readable } = require('stream');
const MailComposer = require('nodemailer/lib/mail-composer');
const DKIM = require('nodemailer/lib/dkim');
const SMTPConnection = require('nodemailer/lib/smtp-connection');
const { resolveMxHosts } = require('./mxResolver');

const CONNECT_TIMEOUT_MS = 15000;
const GREETING_TIMEOUT_MS = 15000;
const SOCKET_TIMEOUT_MS = 30000;

// Intervalo mínimo (ms) entre dois envios para o MESMO domínio de
// destino, só na memória deste processo. Sem isso, um disparo para uma
// lista com muitos "@gmail.com" bateria na porta do Gmail rápido demais e
// levaria a um bloqueio temporário (rate limit / tarpit) do provedor.
const DOMAIN_MIN_GAP_MS = {
  'gmail.com': 2000,
  'googlemail.com': 2000,
  'outlook.com': 2000,
  'hotmail.com': 2000,
  'live.com': 2000,
  'yahoo.com': 2500,
  'yahoo.com.br': 2500,
  'icloud.com': 2500,
  default: 400
};
const lastSentAtByDomain = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleForDomain(domain) {
  const gap = DOMAIN_MIN_GAP_MS[domain] || DOMAIN_MIN_GAP_MS.default;
  const last = lastSentAtByDomain.get(domain) || 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastSentAtByDomain.set(domain, Date.now());
}

/** Monta a mensagem MIME (texto, HTML, anexos, cabeçalhos) a partir das opções, sem assinar ainda. */
function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    const composer = new MailComposer(mailOptions);
    const mimeNode = composer.compile();
    mimeNode.build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

/** Assina a mensagem já montada com DKIM (RSA-SHA256, canonicalização relaxed/relaxed). */
function signWithDkim(rawMessage, { domainName, keySelector, privateKey }) {
  return new Promise((resolve, reject) => {
    let dkim;
    try {
      dkim = new DKIM({ domainName, keySelector, privateKey });
    } catch (err) {
      return reject(err);
    }
    const input = Readable.from([rawMessage]);
    const output = dkim.sign(input);
    const chunks = [];
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
}

/**
 * Classifica a resposta do servidor de destino:
 *  - "bounce": recusa definitiva (endereço não existe, domínio bloqueou
 *    remetente) — 5xx. Não adianta tentar de novo.
 *  - "transient": falha passageira (caixa cheia, servidor ocupado,
 *    saudação recusada por enquanto) — 4xx ou erro de rede/timeout. Vale
 *    tentar de novo mais tarde.
 */
function classifySmtpError(error) {
  const code = error && error.responseCode;
  if (typeof code === 'number' && code >= 500) return 'bounce';
  return 'transient';
}

function sendViaConnection({ mxHost, fromEmail, toEmail, rawMessage, heloName }) {
  return new Promise((resolve, reject) => {
    const connection = new SMTPConnection({
      host: mxHost,
      port: 25,
      name: heloName,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      // Usa STARTTLS quando o servidor de destino oferece, sem exigir —
      // muitos servidores de recebimento aceitam texto puro na porta 25.
      opportunisticTLS: true,
      tls: { rejectUnauthorized: false, servername: mxHost },
      logger: false
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        connection.close();
      } catch {
        // conexão já encerrada
      }
      fn(arg);
    };

    connection.once('error', (err) => finish(reject, err));

    connection.connect(() => {
      connection.send({ from: fromEmail, to: [toEmail] }, rawMessage, (err, info) => {
        if (err) return finish(reject, err);
        finish(resolve, { smtpResponse: (info && info.response) || 'OK' });
      });
    });
  });
}

/**
 * Entrega a mensagem (já pronta e assinada) diretamente na caixa do
 * destinatário: descobre os servidores MX do domínio e tenta cada um, em
 * ordem de prioridade, até um aceitar.
 */
async function deliverToMx({ fromEmail, toEmail, rawMessage, heloName }) {
  const recipientDomain = (toEmail.split('@')[1] || '').toLowerCase();
  if (!recipientDomain) {
    const err = new Error('Endereço de e-mail do destinatário é inválido.');
    err.classification = 'bounce';
    throw err;
  }

  await throttleForDomain(recipientDomain);

  const mxHosts = await resolveMxHosts(recipientDomain);
  if (mxHosts.length === 0) {
    const err = new Error(`O domínio "${recipientDomain}" não tem servidor de e-mail (MX) configurado.`);
    err.classification = 'bounce';
    throw err;
  }

  let lastError = null;

  for (const mxHost of mxHosts) {
    try {
      const result = await sendViaConnection({ mxHost, fromEmail, toEmail, rawMessage, heloName });
      return { mxHost, ...result };
    } catch (error) {
      lastError = error;
      lastError.mxHost = mxHost;
      const classification = classifySmtpError(error);
      lastError.classification = classification;
      // Uma recusa 5xx no nível do endereço (RCPT TO) é definitiva —
      // não adianta tentar outro MX do mesmo provedor.
      if (classification === 'bounce') throw lastError;
      // Erro de conexão/timeout/4xx: tenta o próximo MX da lista.
    }
  }

  throw lastError || Object.assign(new Error('Não foi possível entregar a mensagem em nenhum servidor MX do destinatário.'), { classification: 'transient' });
}

module.exports = {
  buildRawMessage,
  signWithDkim,
  deliverToMx,
  classifySmtpError
};