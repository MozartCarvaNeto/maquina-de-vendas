// backend/src/services/email/emailDomainService.js
//
// Cadastro do(s) domínio(s) de e-mail próprios da empresa, com geração
// automática do par de chaves DKIM e verificação dos registros de DNS
// (SPF, DKIM, DMARC) que a pessoa precisa cadastrar no painel do domínio
// (Registro.br, GoDaddy, Cloudflare, etc.) — a mesma coisa que qualquer
// plataforma paga de e-mail (Resend, Brevo, Mailchimp) pede para fazer,
// só que aqui é 100% seu, sem mensalidade.
const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const prisma = require('../../config/db');
const { encrypt, decrypt } = require('../crypto/settingsCrypto');

const DKIM_SELECTOR = 'mdv';

function normalizeDomain(rawDomain) {
  return String(rawDomain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/** Extrai só o miolo em base64 da chave pública PEM, formato exigido no registro TXT do DKIM. */
function publicKeyPemToDnsValue(publicKeyPem) {
  return publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\r?\n/g, '')
    .trim();
}

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Tenta descobrir o IP público deste servidor, para sugerir no registro SPF. Nunca trava o fluxo se falhar. */
function detectPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=text', { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const value = body.trim();
        // Se a rede estiver bloqueada/indisponível, o serviço pode responder
        // com uma página de erro em vez de um IP — nunca use isso como se
        // fosse o IP real.
        resolve(IPV4_REGEX.test(value) ? value : null);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function sendingHostnameFor(domain) {
  return `mail.${domain}`;
}

function buildDnsInstructions(domainRow, publicIp) {
  const dkimHost = `${domainRow.dkimSelector}._domainkey.${domainRow.domain}`;
  const dkimValue = `v=DKIM1; k=rsa; p=${publicKeyPemToDnsValue(domainRow.dkimPublicKeyPem)}`;
  const sendingHostname = sendingHostnameFor(domainRow.domain);

  return [
    {
      purpose: 'SPF — autoriza este servidor a enviar e-mail em nome do seu domínio.',
      type: 'TXT',
      host: '@ (raiz do domínio)',
      value: publicIp ? `v=spf1 ip4:${publicIp} ~all` : 'v=spf1 ip4:SEU_IP_PUBLICO_AQUI ~all',
      required: true
    },
    {
      purpose: 'DKIM — assina os e-mails para provar que não foram falsificados.',
      type: 'TXT',
      host: dkimHost,
      value: dkimValue,
      required: true
    },
    {
      purpose: 'DMARC — recomendado pelo Gmail/Yahoo desde 2024 para remetentes em volume.',
      type: 'TXT',
      host: `_dmarc.${domainRow.domain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:${domainRow.bounceLocalPart}@${domainRow.domain}`,
      required: false
    },
    {
      purpose:
        'Hostname de envio (HELO) — crie este registro A apontando para o IP público do servidor e depois peça ao seu provedor de hospedagem para configurar o PTR (DNS reverso) desse mesmo IP apontando de volta para este nome. Gmail/Outlook recusam remetentes onde isso não bate (FCrDNS).',
      type: 'A',
      host: sendingHostname,
      value: publicIp || 'SEU_IP_PUBLICO_AQUI',
      required: true
    }
  ];
}

async function createOrUpdateDomain(userId, rawDomain, identity = {}) {
  const domain = normalizeDomain(rawDomain);
  if (!domain || !domain.includes('.')) {
    const err = new Error('Informe um domínio válido, ex: suaempresa.com.br');
    err.status = 400;
    throw err;
  }

  const existing = await prisma.emailDomain.findUnique({
    where: { userId_domain: { userId, domain } }
  });
  if (existing) return existing;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // O primeiro domínio cadastrado na conta já nasce como padrão — assim quem
  // só usa uma empresa/marca nem precisa saber que esse conceito existe.
  const isFirstDomain = (await prisma.emailDomain.count({ where: { userId } })) === 0;

  return prisma.emailDomain.create({
    data: {
      userId,
      domain,
      fromEmail: identity.fromEmail || `contato@${domain}`,
      fromName: identity.fromName || domain,
      isDefault: isFirstDomain,
      dkimSelector: DKIM_SELECTOR,
      dkimPublicKeyPem: publicKey,
      dkimPrivateKeyEnc: encrypt(privateKey)
    }
  });
}

/** Muda o nome/e-mail de remetente sugerido para este domínio (não precisa recriar as chaves DKIM). */
async function updateIdentity(userId, domainId, { fromEmail, fromName }) {
  const domainRow = await prisma.emailDomain.findFirst({ where: { id: domainId, userId } });
  if (!domainRow) {
    const err = new Error('Domínio não encontrado.');
    err.status = 404;
    throw err;
  }
  if (fromEmail && !fromEmail.toLowerCase().endsWith(`@${domainRow.domain}`)) {
    const err = new Error(`O e-mail precisa terminar com "@${domainRow.domain}".`);
    err.status = 400;
    throw err;
  }
  return prisma.emailDomain.update({
    where: { id: domainId },
    data: {
      fromEmail: fromEmail || domainRow.fromEmail,
      fromName: fromName || domainRow.fromName
    }
  });
}

/** Marca este domínio como o padrão da conta (usado quando o disparo não escolhe um explicitamente). */
async function setDefaultDomain(userId, domainId) {
  const domainRow = await prisma.emailDomain.findFirst({ where: { id: domainId, userId } });
  if (!domainRow) {
    const err = new Error('Domínio não encontrado.');
    err.status = 404;
    throw err;
  }
  await prisma.$transaction([
    prisma.emailDomain.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.emailDomain.update({ where: { id: domainId }, data: { isDefault: true } })
  ]);
  return prisma.emailDomain.findUnique({ where: { id: domainId } });
}

async function listDomains(userId) {
  return prisma.emailDomain.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

async function getDnsSetupInstructions(userId, domainId) {
  const domainRow = await prisma.emailDomain.findFirst({ where: { id: domainId, userId } });
  if (!domainRow) {
    const err = new Error('Domínio não encontrado.');
    err.status = 404;
    throw err;
  }
  const publicIp = await detectPublicIp();
  return { domain: domainRow, publicIp, records: buildDnsInstructions(domainRow, publicIp) };
}

/** Consulta o DNS público de verdade e confere se os registros batem com o esperado. */
async function verifyDomain(userId, domainId) {
  const domainRow = await prisma.emailDomain.findFirst({ where: { id: domainId, userId } });
  if (!domainRow) {
    const err = new Error('Domínio não encontrado.');
    err.status = 404;
    throw err;
  }

  const expectedDkimValue = publicKeyPemToDnsValue(domainRow.dkimPublicKeyPem);

  const [spfVerified, dkimVerified, dmarcVerified] = await Promise.all([
    checkTxtContains(domainRow.domain, 'v=spf1'),
    checkTxtContains(`${domainRow.dkimSelector}._domainkey.${domainRow.domain}`, expectedDkimValue),
    checkTxtContains(`_dmarc.${domainRow.domain}`, 'v=DMARC1')
  ]);

  return prisma.emailDomain.update({
    where: { id: domainRow.id },
    data: { spfVerified, dkimVerified, dmarcVerified, lastCheckedAt: new Date() }
  });
}

async function checkTxtContains(hostname, expectedSubstring) {
  try {
    const records = await dns.resolveTxt(hostname);
    // cada registro TXT vem como um array de pedaços de string — junta antes de comparar.
    const joined = records.map((parts) => parts.join('')).join(' ');
    return joined.includes(expectedSubstring);
  } catch {
    return false;
  }
}

async function deleteDomain(userId, domainId) {
  await prisma.emailDomain.deleteMany({ where: { id: domainId, userId } });
}

/**
 * Usado pelo emailProviderFactory para descobrir qual domínio/identidade usar
 * ao enviar: um domínio específico (quando o disparo escolheu um), ou o
 * domínio marcado como padrão da conta, ou — se só existir um — esse único.
 * Sempre devolve a chave DKIM já descriptografada, pronta pra assinar.
 */
async function getActiveDomainForSending(userId, { domainId } = {}) {
  let domainRow = null;

  if (domainId) {
    domainRow = await prisma.emailDomain.findFirst({ where: { id: domainId, userId, isActive: true } });
  } else {
    domainRow = await prisma.emailDomain.findFirst({ where: { userId, isActive: true, isDefault: true } });
    if (!domainRow) {
      const allDomains = await prisma.emailDomain.findMany({ where: { userId, isActive: true } });
      if (allDomains.length === 1) domainRow = allDomains[0];
    }
  }

  if (!domainRow) return null;
  return {
    ...domainRow,
    dkimPrivateKey: decrypt(domainRow.dkimPrivateKeyEnc),
    // Nome usado no HELO/EHLO da conexão SMTP — precisa bater com o PTR
    // (DNS reverso) do IP do servidor, ou grandes provedores recusam.
    sendingHostname: sendingHostnameFor(domainRow.domain)
  };
}

module.exports = {
  normalizeDomain,
  createOrUpdateDomain,
  updateIdentity,
  setDefaultDomain,
  listDomains,
  getDnsSetupInstructions,
  verifyDomain,
  deleteDomain,
  getActiveDomainForSending
};