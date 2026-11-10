// backend/src/services/onboardingService.js
// Checklist de primeiro acesso: mostra ao dono/admin do cliente o que falta fazer, só dos módulos que o plano inclui.
const prisma = require('../config/db');
const { accountHasFeature } = require('./featureService');

async function steps(accountId, { isPlatformAdmin = false } = {}) {
  const has = async (k) => isPlatformAdmin || accountHasFeature(accountId, k);
  const [conexoes, contatos, disparos, gateway, discador, agenteIa] = await Promise.all(['conexoes', 'contatos', 'disparos', 'gateway', 'discador', 'agente_ia'].map(has));
  const acc = await prisma.account.findUnique({ where: { id: accountId }, select: { taxId: true, legalName: true, onboardingDismissed: true, termsVersion: true } });
  const [wa, leads, bc, members, wallet, dids, callers, agents, sms] = await Promise.all([
    conexoes ? prisma.whatsappConnection.count({ where: { userId: accountId, status: 'conectado' } }) : 0,
    contatos ? prisma.lead.count({ where: { userId: accountId } }) : 0,
    disparos ? prisma.broadcastCampaign.count({ where: { userId: accountId } }) : 0,
    prisma.member.count({ where: { accountId, status: 'ativo' } }),
    gateway ? prisma.wallet.findUnique({ where: { userId: accountId } }) : null,
    gateway ? prisma.pbxDid.count({ where: { accountId } }).catch(() => 0) : 0,
    discador || agenteIa ? prisma.callerNumber.count({ where: { userId: accountId } }).catch(() => 0) : 0,
    agenteIa ? prisma.aiVoiceAgent.count({ where: { userId: accountId } }).catch(() => 0) : 0,
    gateway ? prisma.smsMessage.count({ where: { userId: accountId, direction: 'out' } }).catch(() => 0) : 0
  ]);
  const list = [];
  const add = (key, title, desc, done, link, cta) => list.push({ key, title, desc, done: !!done, link, cta });
  if (conexoes) add('whatsapp', 'Conecte seu WhatsApp', 'Leia o QR Code para começar a conversar e disparar.', wa > 0, '/conexoes', 'Conectar');
  if (contatos) add('contatos', 'Traga seus contatos', 'Importe uma lista ou busque empresas para prospectar.', leads > 0, '/contatos', 'Adicionar contatos');
  if (disparos) add('disparo', 'Faça seu primeiro disparo', 'Crie uma campanha com sua mensagem. Comece com poucos contatos.', bc > 0, '/disparos', 'Criar disparo');
  if (gateway) add('saldo', 'Coloque saldo para telefonia', 'SMS, ligações e números usam o saldo. Recarregue por Pix, boleto ou cartão.', wallet && (wallet.balanceBrl > 0 || wallet.enabled), '/gateway', 'Recarregar');
  if (gateway) add('sms', 'Envie um SMS de teste', 'Confirme que as mensagens chegam no seu celular.', sms > 0, '/gateway', 'Enviar teste');
  if (gateway && !dids && !callers) add('numero', 'Tenha um número de telefone', 'O número aparece para quem você liga e recebe as chamadas.', dids > 0, '/pbx', 'Ver números');
  if (agenteIa) add('agente', 'Crie seu primeiro agente de IA', 'Escolha um modelo pronto, ajuste o roteiro e teste.', agents > 0, '/ligacoes', 'Criar agente');
  add('equipe', 'Convide sua equipe', 'Cada pessoa entra com o próprio acesso.', members > 1, '/equipe', 'Convidar');
  add('fiscal', 'Complete os dados para recibo e nota', 'CPF/CNPJ e endereço, usados nos recibos e na nota fiscal.', !!(acc?.taxId && acc?.legalName), '/assinatura', 'Preencher');
  const done = list.filter((s) => s.done).length;
  return { steps: list, done, total: list.length, percent: list.length ? Math.round((done / list.length) * 100) : 100, dismissed: !!acc?.onboardingDismissed };
}

async function dismiss(accountId, value = true) {
  await prisma.account.update({ where: { id: accountId }, data: { onboardingDismissed: !!value } });
}

module.exports = { steps, dismiss };
