// backend/src/services/campaignBotService.js
//
// Cérebro do robô de atendimento por WhatsApp:
//  1) descobre DE QUAL CAMPANHA o lead veio (anúncio do Facebook, código no link
//     do Google, indicação, cliente que já compra, contato espontâneo...);
//  2) monta o prompt do robô a partir dos campos guiados da campanha + catálogo;
//  3) responde, registra as respostas de qualificação e passa para um humano
//     quando necessário.
// É usado igualmente pela conexão QR Code e pela API Oficial da Meta.
const prisma = require('../config/db');
const { evaluateAnswers } = require('./qualificationEngine');
const { buildCatalogContext, normalize } = require('./ai/voice/catalogService');

const SOURCE_TYPES = {
  facebook_ads: 'Facebook/Instagram Ads',
  google_ads: 'Google Ads',
  instagram: 'Instagram (orgânico)',
  indicacao: 'Indicação',
  site: 'Site / loja online',
  cliente: 'Cliente já existente',
  organico: 'Contato espontâneo',
  importado: 'Lista importada',
  outro: 'Outra origem'
};

const TONES = {
  cordial: 'cordial, educado e acolhedor',
  descontraido: 'descontraído e próximo, como uma conversa de WhatsApp entre conhecidos',
  formal: 'formal e profissional',
  consultivo: 'consultivo: entende a necessidade antes de oferecer, sem pressão'
};

const OBJECTIVES = {
  qualificar: 'Qualificar o contato: descobrir se ele tem perfil e interesse, fazendo as perguntas de qualificação uma de cada vez.',
  vender: 'Vender: tirar dúvidas, apresentar a opção certa do catálogo e conduzir para o fechamento.',
  agendar: 'Agendar: levar o contato a marcar uma conversa, visita ou ligação com a equipe.',
  suporte: 'Suporte e relacionamento: ajudar com dúvidas, pedidos e recompra de quem já é cliente.'
};

const HUMAN_TAG = 'atendimento-humano';

// ---------------------------------------------------------------- origem do lead

function sourceFromCampaign(campaign) {
  return campaign?.sourceType && campaign.sourceType !== 'outro' ? campaign.sourceType : 'outro';
}

function isExistingCustomer(lead) {
  const tags = (lead.tags || []).map((t) => normalize(t));
  return Boolean(lead.lastPurchaseAt) || tags.includes('cliente') || tags.includes('cliente ativo');
}

/** Procura, na 1ª mensagem, o código/frase que identifica uma campanha (vence o mais específico). */
function matchKeyword(campaigns, text) {
  const haystack = ` ${normalize(text)} `;
  if (!haystack.trim()) return null;
  let best = null;
  for (const campaign of campaigns) {
    for (const keyword of campaign.triggerKeywords || []) {
      const needle = normalize(keyword);
      if (needle.length < 3) continue;
      if (haystack.includes(` ${needle} `) || haystack.includes(needle)) {
        if (!best || needle.length > best.length) best = { campaign, keyword, length: needle.length };
      }
    }
  }
  return best;
}

/**
 * Decide campanha + origem. Ordem (a mais confiável primeiro):
 *  1. anúncio "Click-to-WhatsApp" (ID do anúncio informado pelo WhatsApp);
 *  2. código/frase da campanha escrita pelo lead (ex.: link rastreável do Google Ads);
 *  3. campanha que o lead já tinha (a conversa continua na mesma campanha);
 *  4. cliente que já comprou  -> campanha padrão, origem "cliente";
 *  5. campanha padrão (clientes regulares, indicação, contato espontâneo).
 */
function resolveRoute({ campaigns, lead, text, referral, connectionId }) {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const detailOf = (kind, extra) => `${kind}${extra ? `: ${extra}` : ''}`.slice(0, 200);

  if (referral && (referral.sourceId || referral.sourceUrl || referral.headline)) {
    const matchAd = campaigns.find((c) => referral.sourceId && (c.adSourceIds || []).includes(String(referral.sourceId)));
    const metaCampaigns = campaigns.filter((c) => c.sourceType === 'facebook_ads' || c.sourceType === 'instagram');
    const campaign = matchAd || (metaCampaigns.length === 1 ? metaCampaigns[0] : null);
    return {
      campaign: campaign || byId.get(lead.campaignId) || campaigns.find((c) => c.isDefault) || null,
      source: 'facebook_ads',
      detail: detailOf('anúncio', referral.headline || referral.sourceId || referral.sourceUrl),
      explicit: true
    };
  }

  const kw = matchKeyword(campaigns, text);
  if (kw) {
    return {
      campaign: kw.campaign,
      source: sourceFromCampaign(kw.campaign),
      detail: detailOf('código', kw.keyword),
      explicit: true
    };
  }

  const current = lead.campaignId ? byId.get(lead.campaignId) : null;
  if (current) {
    return { campaign: current, source: lead.source || sourceFromCampaign(current), detail: lead.sourceDetail || 'campanha do lead', explicit: false };
  }

  // Número de WhatsApp dedicado a uma campanha: quem escreve para ele entra nela.
  const byNumber = connectionId ? campaigns.find((c) => c.whatsappConnectionId === connectionId) : null;
  if (byNumber && !isExistingCustomer(lead)) {
    return { campaign: byNumber, source: sourceFromCampaign(byNumber), detail: 'número do WhatsApp da campanha', explicit: false };
  }

  const fallback = campaigns.find((c) => c.isDefault) || null;
  if (isExistingCustomer(lead)) {
    return { campaign: fallback, source: 'cliente', detail: 'cliente com compra/etiqueta', explicit: false };
  }
  const defSource = fallback && ['organico', 'indicacao', 'site', 'cliente'].includes(fallback.sourceType) ? fallback.sourceType : 'organico';
  return { campaign: fallback, source: lead.source || defSource, detail: lead.sourceDetail || 'sem código de campanha', explicit: false };
}

// ---------------------------------------------------------------- prompt

function clip(value, max = 3000) {
  return String(value ?? '').trim().slice(0, max);
}

function originInstruction(source, campaign) {
  const name = campaign?.name ? ` (campanha "${campaign.name}")` : '';
  switch (source) {
    case 'facebook_ads':
    case 'instagram':
      return `Este contato veio de um anúncio no Facebook/Instagram${name}. É um contato novo: apresente-se, confirme o interesse no que o anúncio ofereceu e conduza a conversa.`;
    case 'google_ads':
      return `Este contato veio de um anúncio no Google${name}. Provavelmente estava pesquisando o produto/serviço: seja direto, responda a dúvida e conduza para o próximo passo.`;
    case 'indicacao':
      return `Este contato chegou por INDICAÇÃO${name}. Agradeça a confiança, pergunte (sem insistir) quem indicou, e trate com atenção especial.`;
    case 'site':
      return `Este contato veio do site/loja online${name}. Pode já conhecer os produtos: ajude com dúvidas de compra, prazo e pagamento.`;
    case 'cliente':
      return 'Este contato JÁ É CLIENTE. Trate com familiaridade, NÃO refaça perguntas de qualificação; ajude com dúvidas, pedidos e recompra.';
    default:
      return `Este contato chegou por conta própria${name}, sem anúncio. Descubra o que ele procura antes de oferecer.`;
  }
}

function describeStep(step) {
  const hint =
    step.type === 'number_min' ? `número (mínimo exigido: ${step.minValue})`
    : step.type === 'number_max' ? `número (máximo permitido: ${step.maxValue})`
    : step.type === 'one_of' ? `uma destas opções exatas: ${(step.acceptedValues || []).join(' | ')}`
    : 'sim ou não (true/false)';
  return `- id "${step.id}": ${step.question} → resposta esperada: ${hint}`;
}

/**
 * Monta o prompt do sistema. `cfg` = campaign.botConfig (campos guiados);
 * campaign.botPrompt (texto livre) continua valendo como instruções extras.
 */
function buildSystemPrompt({ campaign, lead, query }) {
  const cfg = campaign.botConfig || {};
  const company = campaign.enterpriseName || cfg.company || 'a empresa';
  const steps = (campaign.qualificationRules?.steps || []).filter((s) => s.id && s.question);
  const source = lead?.source || sourceFromCampaign(campaign);
  const parts = [];

  parts.push(
    `Você é ${clip(cfg.persona, 80) || 'o assistente virtual'} de ${company}, atendendo clientes pelo WhatsApp. ` +
      'Escreva sempre em português do Brasil, em mensagens curtas (no máximo 3 frases), como uma pessoa real no WhatsApp. ' +
      'Faça UMA pergunta por vez. Nunca invente informações.'
  );
  parts.push(`## Quem está falando com você\n${originInstruction(source, campaign)}${lead?.name ? ` Nome do contato: ${clip(lead.name, 80)}.` : ''}`);
  parts.push(`## Seu objetivo\n${OBJECTIVES[cfg.objective] || OBJECTIVES.qualificar}`);
  parts.push(`## Tom de voz\n${TONES[cfg.tone] || TONES.cordial}.${cfg.emojis === false ? ' Não use emojis.' : ' Pode usar poucos emojis.'}`);
  if (clip(cfg.offer)) parts.push(`## O que oferecemos\n${clip(cfg.offer)}`);
  if (clip(cfg.audience, 600)) parts.push(`## Público ideal\n${clip(cfg.audience, 600)}`);
  if (clip(campaign.firstMessage, 600)) parts.push(`## Abertura sugerida\nNa sua primeira resposta, use esta mensagem (adapte ao que o contato escreveu): ${clip(campaign.firstMessage, 600)}`);
  if (clip(cfg.rules)) parts.push(`## Faça sempre\n${clip(cfg.rules)}`);
  if (clip(cfg.forbidden)) parts.push(`## Nunca faça\n${clip(cfg.forbidden)}`);
  if (clip(cfg.faq)) parts.push(`## Perguntas frequentes (use estas respostas)\n${clip(cfg.faq)}`);

  if (source !== 'cliente' && steps.length) {
    parts.push(
      `## Perguntas de qualificação\nDescubra, de forma natural e uma por vez, as informações abaixo. Não repita o que o contato já respondeu.\n${steps.map(describeStep).join('\n')}`
    );
  }

  const catalog = buildCatalogContext(campaign, query || '');
  parts.push(
    `## Catálogo / base de conhecimento\nResponda sobre produtos, preços e prazos SOMENTE com base nos trechos abaixo. Se a informação não estiver aqui, diga que vai confirmar com a equipe — não invente.\n${catalog}`
  );

  parts.push(
    `## Passar para uma pessoa\n${clip(cfg.handoff) || 'Passe para um atendente humano quando o contato pedir, estiver irritado, ou quando o assunto fugir do que você sabe.'}\nAo passar, avise com gentileza que um atendente continuará a conversa.`
  );
  if (clip(cfg.closing, 600)) parts.push(`## Próximo passo desejado\n${clip(cfg.closing, 600)}`);
  if (clip(campaign.botPrompt)) parts.push(`## Instruções adicionais\n${clip(campaign.botPrompt)}`);

  parts.push(
    '## Códigos internos (o contato NUNCA vê)\n' +
      '- Quando o contato responder uma pergunta de qualificação, termine a mensagem com uma linha: [[DADOS:{"id_da_pergunta":valor}]] (JSON válido; só os campos novos; número como número, sim/não como true/false, opção exatamente como listada).\n' +
      '- Se for preciso passar para um humano, termine a mensagem com a linha: [[HUMANO]].\n' +
      '- Nunca explique nem mencione estes códigos.'
  );

  return parts.join('\n\n');
}

/** Separa a resposta visível dos códigos internos [[DADOS:...]] e [[HUMANO]]. */
function parseBotReply(raw) {
  let text = String(raw || '');
  let data = null;
  let handoff = false;

  text = text.replace(/\[\[\s*DADOS\s*:\s*([\s\S]*?)\]\]/gi, (_, json) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = { ...(data || {}), ...parsed };
    } catch {
      // JSON inválido: ignora, a resposta continua valendo
    }
    return '';
  });
  text = text.replace(/\[\[\s*HUMANO\s*\]\]/gi, () => {
    handoff = true;
    return '';
  });
  text = text.replace(/\[\[[^\]]*\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, data, handoff };
}

/** Só aceita respostas de perguntas que existem e converte para o tipo certo. */
function sanitizeAnswers(steps, data) {
  const out = {};
  if (!data) return out;
  for (const step of steps) {
    if (!(step.id in data)) continue;
    const value = data[step.id];
    if (value === null || value === undefined || value === '') continue;
    if (step.type === 'number_min' || step.type === 'number_max') {
      const n = Number(String(value).replace(/\./g, '').replace(',', '.'));
      out[step.id] = Number.isNaN(n) ? Number(value) : n;
      if (Number.isNaN(out[step.id])) delete out[step.id];
    } else if (step.type === 'boolean_true') {
      out[step.id] = value === true || ['true', 'sim', 's', 'yes'].includes(normalize(String(value)));
    } else if (step.type === 'one_of') {
      const match = (step.acceptedValues || []).find((v) => normalize(v) === normalize(String(value)));
      out[step.id] = match !== undefined ? match : String(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------- fluxo principal

function botIsOn(campaign) {
  return Boolean(campaign && campaign.active && campaign.botEnabled !== false && (campaign.botPrompt || campaign.botConfig));
}

async function recentHistory(leadId, incomingText) {
  const rows = await prisma.message.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 20 });
  const ordered = rows.reverse();
  // A mensagem que acabou de chegar já foi salva: ela vai separada, não no histórico.
  const last = ordered[ordered.length - 1];
  if (last && last.direction === 'entrada' && last.body === incomingText) ordered.pop();
  return ordered.map((m) => ({ role: m.direction === 'entrada' ? 'user' : 'model', text: m.body }));
}

async function saveAndEmit(userId, leadId, body) {
  const saved = await prisma.message.create({ data: { leadId, direction: 'saida', channel: 'whatsapp', body } });
  const io = global.socketIoInstance;
  if (io) io.to(`user:${userId}`).emit('whatsapp:message', { leadId, message: saved });
  return saved;
}

async function applyAnswers(lead, campaign, answers) {
  const steps = (campaign.qualificationRules?.steps || []).filter((s) => s.id);
  const merged = { ...(lead.qualificationAnswers || {}), ...answers };
  await prisma.lead.update({ where: { id: lead.id }, data: { qualificationAnswers: merged } });

  const allAnswered = steps.length > 0 && steps.every((s) => merged[s.id] !== undefined && merged[s.id] !== null && merged[s.id] !== '');
  if (allAnswered && !['qualificado', 'desqualificado'].includes(lead.status)) {
    try {
      const { processQualification } = require('./leadPipelineService');
      await processQualification({ leadId: lead.id, answers: merged });
    } catch (error) {
      console.warn(`Qualificação automática não concluída (lead ${lead.id}):`, error.message);
    }
  }
  return merged;
}

/**
 * Chamado a cada mensagem recebida (QR Code ou API Oficial).
 * Nunca lança erro: um problema no robô não pode derrubar o recebimento.
 */
async function handleIncoming({ userId, connectionId, lead, text, referral, sendReply }) {
  try {
    const campaigns = await prisma.campaign.findMany({ where: { userId, active: true } });
    const route = resolveRoute({ campaigns, lead, text, referral, connectionId });

    // Registra a origem (só sobrescreve quando houve um sinal explícito, ou se ainda estava vazia).
    const patch = {};
    if (connectionId && lead.lastConnectionId !== connectionId) patch.lastConnectionId = connectionId;
    if (route.campaign && lead.campaignId !== route.campaign.id && (route.explicit || !lead.campaignId)) patch.campaignId = route.campaign.id;
    if (route.explicit || !lead.source) {
      if (lead.source !== route.source) patch.source = route.source;
      if (lead.sourceDetail !== route.detail) patch.sourceDetail = route.detail;
    }
    if (Object.keys(patch).length) {
      lead = await prisma.lead.update({ where: { id: lead.id }, data: patch });
    }

    const campaign = route.campaign;
    if (!botIsOn(campaign) || lead.optOut) return;
    if ((lead.tags || []).includes(HUMAN_TAG)) return; // um atendente assumiu a conversa

    const { getActiveAiProvider } = require('./ai/aiProviderFactory');
    const provider = await getActiveAiProvider(userId, campaign.aiProviderOverride);
    if (!provider) return;

    const history = await recentHistory(lead.id, text);
    const recentUser = history.filter((h) => h.role === 'user').slice(-2).map((h) => h.text).join(' ');
    const system = buildSystemPrompt({ campaign, lead, query: `${recentUser} ${text}` });

    const raw = await provider.generateReply(system, history, text);
    const reply = parseBotReply(raw);

    if (reply.text) {
      await sendReply(reply.text);
      await saveAndEmit(userId, lead.id, reply.text);
    }

    const steps = campaign.qualificationRules?.steps || [];
    const answers = sanitizeAnswers(steps, reply.data);
    if (Object.keys(answers).length) await applyAnswers(lead, campaign, answers);

    if (reply.handoff) {
      const tags = Array.from(new Set([...(lead.tags || []), HUMAN_TAG]));
      await prisma.lead.update({ where: { id: lead.id }, data: { tags } });
      const io = global.socketIoInstance;
      if (io) io.to(`user:${userId}`).emit('lead:handoff', { leadId: lead.id, name: lead.name });
    }
  } catch (error) {
    console.error(`Erro no robô de atendimento (conexão ${connectionId}):`, error.message);
  }
}

module.exports = {
  SOURCE_TYPES,
  TONES,
  OBJECTIVES,
  HUMAN_TAG,
  resolveRoute,
  buildSystemPrompt,
  parseBotReply,
  sanitizeAnswers,
  handleIncoming,
  botIsOn,
  isExistingCustomer
};
