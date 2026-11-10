// backend/src/services/legalService.js
// Termos de Uso e Política de Privacidade. Os textos são um MODELO: o administrador deve revisar com
// um advogado e pode trocar qualquer trecho gravando seu próprio texto (Configurações da plataforma → legal).
// Mudou a versão (LEGAL_VERSION ou o texto próprio) → quem já usa o sistema precisa aceitar de novo.
const crypto = require('crypto');
const { readStoredCredentials, persistCredentials } = require('./settingsHelpers');

const CATEGORY = 'platform_telecom';
const PROVIDER = 'legal';

async function platformId() {
  return (await require('./platformService').platformAccountIds())[0] || null;
}
async function getPlatformSetting() {
  const pid = await platformId();
  if (!pid) return null;
  const v = await readStoredCredentials(pid, CATEGORY, PROVIDER).catch(() => ({}));
  try { return v.doc ? JSON.parse(v.doc) : null; } catch (_) { return null; }
}
async function savePlatformSetting(_k, doc) {
  const pid = await platformId();
  if (!pid) throw Object.assign(new Error('Nenhuma conta de administrador da plataforma encontrada (SUPERADMIN_EMAILS).'), { status: 400 });
  await persistCredentials(pid, CATEGORY, PROVIDER, { doc: JSON.stringify(doc) }, [], { exclusive: false });
}

const DEFAULT_VERSION = '2026-11';

function company() {
  return {
    name: process.env.LEGAL_COMPANY_NAME || 'Turbo Prospect',
    taxId: process.env.LEGAL_COMPANY_TAX_ID || '',
    email: process.env.LEGAL_CONTACT_EMAIL || process.env.SYSTEM_MAIL_FROM || 'contato@turboprospect.com.br',
    site: process.env.FRONTEND_URL || 'https://app.turboprospect.com.br'
  };
}

function defaultTerms(c) {
  return [
    { h: '1. Quem somos e o que oferecemos', p: [`${c.name}${c.taxId ? ` (CNPJ/CPF ${c.taxId})` : ''} oferece uma plataforma online de prospecção e vendas com WhatsApp, SMS, ligações, atendimento por inteligência artificial, CRM e disparos de mensagens (“Serviço”). Ao criar uma conta você declara que leu e concorda com estes Termos.`] },
    { h: '2. Cadastro e responsabilidade pela conta', p: ['Você deve informar dados verdadeiros e manter sua senha em segredo. Tudo que for feito na conta, inclusive por membros da sua equipe, é de sua responsabilidade.', 'O acesso pode ser aprovado manualmente e é pessoal da empresa contratante; é proibido revender ou compartilhar o acesso sem autorização por escrito.'] },
    { h: '3. Planos, créditos e pagamento', p: ['O Serviço é cobrado por mensalidade do plano escolhido e, nos recursos de telefonia (SMS, ligações, números e IA de voz), também por uso, descontado de um saldo pré-pago que você recarrega.', 'Recargas e mensalidades pagas não são reembolsáveis, exceto quando a lei exigir. Créditos não utilizados não rendem juros. Em caso de falta de pagamento ou de saldo, o Serviço pode ser suspenso, e números de telefone alugados podem ser liberados.', 'Os preços podem mudar com aviso prévio de 30 dias para planos já contratados.'] },
    { h: '4. Uso permitido', p: ['Você só pode enviar mensagens e fazer ligações para pessoas que consentiram em receber ou que tenham outra base legal válida, e deve respeitar imediatamente pedidos de descadastro (a plataforma oferece lista de bloqueio e respeita respostas como SAIR/PARAR).', 'É proibido usar o Serviço para spam, golpes, fraude, assédio, conteúdo ilegal, ofensivo ou enganoso, para se passar por outra pessoa ou empresa, para ligar sem identificação correta quando ela for exigida, ou para descumprir regras da Anatel, do WhatsApp/Meta, das operadoras e da LGPD.', 'Podemos suspender ou encerrar contas que coloquem em risco a plataforma, as operadoras ou terceiros, sem reembolso.'] },
    { h: '5. Gravação de ligações e inteligência artificial', p: ['Ligações podem ser gravadas e transcritas para qualidade e histórico. Você é responsável por avisar as pessoas contatadas quando a lei exigir (por exemplo, “esta ligação pode ser gravada”).', 'Respostas geradas por inteligência artificial podem conter erros; revise campanhas e roteiros antes de usar.'] },
    { h: '6. Disponibilidade', p: ['Trabalhamos para manter o Serviço no ar, mas ele depende de terceiros (operadoras, WhatsApp, provedores de nuvem e de IA) e pode ter instabilidades, manutenções e bloqueios fora do nosso controle. O WhatsApp pode banir números por uso indevido; isso não gera direito a indenização.'] },
    { h: '7. Responsabilidade', p: ['Na extensão permitida em lei, nossa responsabilidade se limita ao valor pago por você nos últimos 3 meses. Não respondemos por lucros cessantes, perda de clientes, multas ou sanções decorrentes do uso indevido do Serviço pela sua conta.'] },
    { h: '8. Cancelamento', p: ['Você pode cancelar quando quiser pelo contato de suporte; o acesso segue até o fim do período já pago. Após o encerramento, seus dados podem ser apagados conforme a Política de Privacidade.'] },
    { h: '9. Alterações e foro', p: ['Podemos atualizar estes Termos; quando houver mudança relevante pediremos novo aceite. Fica eleito o foro da comarca do domicílio do contratante consumidor ou, nos demais casos, o da sede da empresa fornecedora.', `Dúvidas: ${c.email}.`] }
  ];
}

function defaultPrivacy(c) {
  return [
    { h: '1. Quem é o controlador', p: [`${c.name} é a controladora dos dados da sua conta (cadastro, cobrança e uso). Quanto aos contatos que você importa ou cadastra (seus leads e clientes), você é o controlador e ${c.name} atua como operadora, tratando os dados apenas para executar o Serviço conforme suas instruções (Lei 13.709/2018, LGPD).`] },
    { h: '2. Dados que tratamos', p: ['Dados de cadastro (nome, e-mail, empresa, CPF/CNPJ e endereço de cobrança); dados de acesso (senha criptografada, endereço IP, registros de login); dados de pagamento (processados pelo Asaas; não guardamos número de cartão); dados de uso (mensagens, ligações, gravações, saldo, extrato); e os dados dos seus contatos que você inserir.'] },
    { h: '3. Para que usamos', p: ['Prestar o Serviço, cobrar, dar suporte, prevenir fraude e abuso, cumprir obrigações legais e fiscais e melhorar a plataforma. Não vendemos seus dados.'] },
    { h: '4. Com quem compartilhamos', p: ['Somente com quem é necessário para o Serviço funcionar: operadoras de telefonia e SMS, WhatsApp/Meta, provedor de pagamento (Asaas), provedores de nuvem e de inteligência artificial/voz, e autoridades quando houver ordem legal. Alguns desses fornecedores podem estar fora do Brasil, com as garantias previstas na LGPD.'] },
    { h: '5. Por quanto tempo guardamos', p: ['Enquanto a conta estiver ativa e, depois, pelo prazo exigido por lei (registros de acesso por 6 meses; dados fiscais por 5 anos). Gravações e mensagens podem ser apagadas a pedido da conta, salvo obrigação legal de guarda.'] },
    { h: '6. Seus direitos', p: [`Você pode pedir confirmação de tratamento, acesso, correção, anonimização, portabilidade, eliminação e informação sobre compartilhamento escrevendo para ${c.email}. Se você é um contato de alguma empresa que usa a plataforma, peça diretamente a ela; podemos ajudar a atender o pedido.`, 'Quem receber SMS, ligação ou mensagem pode pedir para não ser mais contatado respondendo SAIR/PARAR ou falando com a atendente; o pedido entra na lista de bloqueio da empresa.'] },
    { h: '7. Segurança', p: ['Usamos conexão criptografada, senhas protegidas, controle de acesso por perfil e isolamento entre contas. Nenhum sistema é totalmente imune; em caso de incidente relevante, avisaremos os afetados e a ANPD conforme a lei.'] },
    { h: '8. Contato do encarregado (DPO)', p: [`${c.email}`] }
  ];
}

let cache = null;
let cacheAt = 0;
async function load(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60000) return cache;
  const c = company();
  let custom = null;
  try { custom = await getPlatformSetting(); } catch (_) { /* sem texto próprio */ }
  const terms = custom?.terms?.length ? custom.terms : defaultTerms(c);
  const privacy = custom?.privacy?.length ? custom.privacy : defaultPrivacy(c);
  const hash = crypto.createHash('sha1').update(JSON.stringify([terms, privacy])).digest('hex').slice(0, 6);
  const version = custom?.version || `${process.env.LEGAL_VERSION || DEFAULT_VERSION}-${hash}`;
  cache = { version, company: c, terms, privacy, custom: !!custom, updatedAt: custom?.updatedAt || null };
  cacheAt = Date.now();
  return cache;
}

/** Salva texto próprio (admin). terms/privacy = [{h, p:[...]}]. */
async function save({ terms, privacy }) {
  const clean = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 40).map((s) => ({ h: String(s.h || '').slice(0, 200), p: (Array.isArray(s.p) ? s.p : [String(s.p || '')]).slice(0, 20).map((x) => String(x).slice(0, 4000)) })).filter((s) => s.h || s.p.length);
  const doc = { terms: clean(terms), privacy: clean(privacy), updatedAt: new Date().toISOString() };
  await savePlatformSetting('legal', doc);
  return load(true);
}

module.exports = { load, save };
