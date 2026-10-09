// backend/src/services/email/emailProviderFactory.js
const prisma = require('../../config/db');
const { decrypt } = require('../crypto/settingsCrypto');
const ResendEmailProvider = require('./ResendEmailProvider');
const SmtpEmailProvider = require('./SmtpEmailProvider');
const NativeEmailProvider = require('./NativeEmailProvider');
const { getActiveDomainForSending } = require('./emailDomainService');

const EMAIL_PROVIDER_REGISTRY = {
  resend: ResendEmailProvider,
  smtp: SmtpEmailProvider,
  // "native": envio direto pelo próprio servidor (DKIM + SMTP direto no MX
  // do destinatário), sem Resend/Brevo/Mailchimp. Registrado aqui só para
  // aparecer na lista de provedores disponíveis e passar na validação de
  // `saveEmailSettings` — a instância de verdade é sempre montada abaixo,
  // em getEmailProvider(), porque ela precisa buscar o domínio e a chave
  // DKIM cadastrados (algo que os outros provedores não têm).
  native: NativeEmailProvider
};

async function getEmailProvider(userId, options = {}) {
  const settings = await prisma.setting.findMany({
    where: { userId, category: 'email', isActive: true }
  });

  if (settings.length === 0) {
    const err = new Error('Nenhum provedor de e-mail configurado. Acesse Configurações > E-mail.');
    err.status = 400;
    throw err;
  }

  const providerName = settings[0].provider;
  const ProviderClass = EMAIL_PROVIDER_REGISTRY[providerName];
  if (!ProviderClass) {
    const err = new Error(`Provedor de e-mail "${providerName}" não suportado.`);
    err.status = 400;
    throw err;
  }

  if (providerName === 'native') {
    // O remetente (nome, e-mail, domínio, chave DKIM) mora inteiramente no
    // domínio cadastrado em Configurações > E-mail > Domínio próprio — não
    // em Setting. Isto é o que permite ter várias identidades (uma por
    // empresa/marca) na mesma conta, e cada disparo escolher a sua.
    const domainRow = await getActiveDomainForSending(userId, { domainId: options.emailDomainId });
    if (!domainRow) {
      const err = new Error(
        options.emailDomainId
          ? 'O domínio selecionado para este disparo não foi encontrado ou foi desativado.'
          : 'Nenhum domínio de e-mail cadastrado ou marcado como padrão. Acesse Configurações > E-mail > E-mail Nativo.'
      );
      err.status = 400;
      throw err;
    }

    return new NativeEmailProvider({
      fromEmail: domainRow.fromEmail,
      fromName: domainRow.fromName,
      userId,
      domain: domainRow.domain,
      dkimSelector: domainRow.dkimSelector,
      dkimPrivateKey: domainRow.dkimPrivateKey,
      bounceLocalPart: domainRow.bounceLocalPart,
      sendingHostname: domainRow.sendingHostname
    });
  }

  const credentials = {};
  for (const setting of settings) {
    credentials[setting.key] = decrypt(setting.value);
  }

  return new ProviderClass(credentials);
}

module.exports = { getEmailProvider, EMAIL_PROVIDER_REGISTRY };