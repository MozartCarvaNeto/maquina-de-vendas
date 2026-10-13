// backend/src/controllers/aiCallController.js
//
// Telas do 3º sistema de ligação (Agente de voz com IA):
// agentes (configuração), campanhas, simulador de conversa, ligação de teste.
const prisma = require('../config/db');
const { countAudience } = require('../services/broadcastService');
const { getActiveTelephonyProvider } = require('../services/telephony/providerFactory');
const { AI_PROVIDER_REGISTRY } = require('../services/ai/aiProviderFactory');
const { listPresets } = require('../services/ai/voice/aiVoicePresets');
const {
  invalidateAgent,
  invalidateProviders,
  getProviderCached,
  runAgentTurn
} = require('../services/ai/voice/aiVoiceEngine');
const {
  validatePublicUrl,
  buildOpeningText,
  startTestCall,
  refreshAgentCatalog,
  executeAiCampaign
} = require('../services/ai/voice/aiCallService');

const VOICES = [
  { id: 'Polly.Camila-Neural', label: 'Camila (feminina, neural) — recomendada' },
  { id: 'Polly.Vitoria-Neural', label: 'Vitória (feminina, neural)' },
  { id: 'Polly.Thiago-Neural', label: 'Thiago (masculina, neural)' },
  { id: 'Polly.Ricardo', label: 'Ricardo (masculina, padrão)' }
];

const asList = (v) => (Array.isArray(v) ? v : []);
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
};
const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1';
};
const slugKey = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// ------------------------------------------------------------------ validação do agente

async function sanitizeAgentBody(body, userId) {
  const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

  const name = text(body.name, 120);
  const companyName = text(body.companyName, 120);
  const objective = text(body.objective, 3000);
  const openingScript = text(body.openingScript, 600);
  const handoffCriteria = text(body.handoffCriteria, 3000);
  if (!name) throw badRequest('Informe o nome do agente.');
  if (!companyName) throw badRequest('Informe o nome da sua empresa (é como a IA vai se apresentar).');
  if (!objective) throw badRequest('Descreva o objetivo da ligação.');
  if (!openingScript) throw badRequest('Escreva a fala de abertura da ligação.');
  if (!handoffCriteria) throw badRequest('Explique quando a IA deve chamar o vendedor.');

  const glossary = asList(body.glossary)
    .map((g) => ({ term: text(g?.term, 80), meaning: text(g?.meaning, 300), pronunciation: text(g?.pronunciation, 80) }))
    .filter((g) => g.term)
    .slice(0, 150);

  const seen = new Set();
  const qualificationFields = asList(body.qualificationFields)
    .map((f) => ({ key: slugKey(f?.key || f?.label), label: text(f?.label, 200), required: !!f?.required }))
    .filter((f) => f.key && !seen.has(f.key) && seen.add(f.key))
    .slice(0, 20);

  let catalogUrl = text(body.catalogUrl, 500) || null;
  if (catalogUrl && !/^https?:\/\//i.test(catalogUrl)) catalogUrl = `https://${catalogUrl}`;

  const handoffMode = body.handoffMode === 'transfer' ? 'transfer' : 'whatsapp';
  const handoffPhone = text(body.handoffPhone, 40) || null;
  if (handoffPhone && handoffPhone.replace(/\D/g, '').length < 10) {
    throw badRequest('O telefone do vendedor precisa ter DDD, por exemplo 11 99999-8888.');
  }

  let handoffAgentId = body.handoffAgentId || null;
  if (handoffAgentId) {
    const seller = await prisma.agent.findFirst({ where: { id: handoffAgentId, userId } });
    if (!seller) throw badRequest('O vendedor escolhido não foi encontrado.');
  }
  if (!handoffPhone && !handoffAgentId) handoffAgentId = null;
  if (handoffMode === 'transfer' && !handoffPhone && !handoffAgentId) {
    throw badRequest('Para transferir a ligação, informe o telefone do vendedor (ou escolha um vendedor cadastrado).');
  }

  let crmColumnId = body.crmColumnId || null;
  if (crmColumnId) {
    const column = await prisma.crmColumn.findFirst({ where: { id: crmColumnId, board: { userId } } });
    if (!column) throw badRequest('A coluna do CRM escolhida não foi encontrada.');
  }

  let aiProvider = body.aiProvider || null;
  if (aiProvider && !AI_PROVIDER_REGISTRY[aiProvider]) aiProvider = null;

  return {
    name,
    market: text(body.market, 60) || 'generico',
    companyName,
    agentName: text(body.agentName, 60) || 'Júlia',
    language: 'pt-BR',
    voice: text(body.voice, 80) || 'Polly.Camila-Neural',
    objective,
    openingScript,
    extraInstructions: text(body.extraInstructions, 3000) || null,
    handoffCriteria,
    glossary,
    qualificationFields,
    catalogText: String(body.catalogText ?? '').slice(0, 60000).trim() || null,
    catalogUrl,
    handoffMode,
    handoffPhone,
    handoffAgentId,
    notifySellerWhatsapp: toBool(body.notifySellerWhatsapp, true),
    leadWhatsappMessage: text(body.leadWhatsappMessage, 1500) || null,
    crmColumnId,
    aiProvider,
    maxTurns: clamp(body.maxTurns, 4, 30, 14),
    maxCallSeconds: clamp(body.maxCallSeconds, 60, 900, 420),
    recordCalls: toBool(body.recordCalls, false)
  };
}

async function findOwnedAgent(req) {
  const agent = await prisma.aiVoiceAgent.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!agent) {
    const err = new Error('Agente não encontrado.');
    err.status = 404;
    throw err;
  }
  return agent;
}

// ------------------------------------------------------------------ opções para a tela

exports.options = async (req, res, next) => {
  try {
    const [sellers, columns] = await Promise.all([
      prisma.agent.findMany({
        where: { userId: req.userId, isActive: true },
        select: { id: true, name: true, phoneNumber: true },
        orderBy: { name: 'asc' }
      }),
      prisma.crmColumn.findMany({
        where: { board: { userId: req.userId } },
        select: { id: true, name: true, board: { select: { name: true } } },
        orderBy: [{ board: { createdAt: 'asc' } }, { position: 'asc' }]
      })
    ]);
    res.json({
      presets: listPresets(),
      voices: VOICES,
      sellers,
      crmColumns: columns.map((c) => ({ id: c.id, label: `${c.board.name} › ${c.name}` })),
      aiProviders: Object.keys(AI_PROVIDER_REGISTRY)
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ agentes

exports.listAgents = async (req, res, next) => {
  try {
    // Sem os textos do catálogo (podem ser grandes): a lista só mostra o resumo.
    const agents = await prisma.aiVoiceAgent.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        market: true,
        companyName: true,
        agentName: true,
        voice: true,
        handoffMode: true,
        catalogUrl: true,
        catalogFetchedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { campaigns: true } }
      }
    });
    res.json({ agents });
  } catch (error) {
    next(error);
  }
};

exports.getAgent = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    res.json({ agent });
  } catch (error) {
    next(error);
  }
};

exports.createAgent = async (req, res, next) => {
  try {
    const data = await sanitizeAgentBody(req.body || {}, req.userId);
    const agent = await prisma.aiVoiceAgent.create({ data: { ...data, userId: req.userId } });
    res.status(201).json({ agent });
  } catch (error) {
    next(error);
  }
};

exports.updateAgent = async (req, res, next) => {
  try {
    const existing = await findOwnedAgent(req);
    const data = await sanitizeAgentBody(req.body || {}, req.userId);
    // Trocou o endereço do site: o texto lido do site antigo deixa de valer.
    const urlChanged = (data.catalogUrl || null) !== (existing.catalogUrl || null);
    const agent = await prisma.aiVoiceAgent.update({
      where: { id: existing.id },
      data: { ...data, ...(urlChanged ? { catalogWebText: null, catalogFetchedAt: null } : {}) }
    });
    invalidateAgent(agent.id);
    res.json({ agent });
  } catch (error) {
    next(error);
  }
};

exports.deleteAgent = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    const campaigns = await prisma.aiCallCampaign.count({ where: { agentId: agent.id } });
    if (campaigns > 0) {
      return res.status(400).json({ error: 'Este agente é usado por campanhas. Exclua as campanhas antes.' });
    }
    await prisma.aiVoiceAgent.delete({ where: { id: agent.id } });
    invalidateAgent(agent.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.refreshCatalog = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    if (!agent.catalogUrl) return res.status(400).json({ error: 'Este agente não tem o endereço do site cadastrado.' });
    const info = await refreshAgentCatalog(agent.id);
    res.json({ success: true, ...info });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ simulador (conversa por texto, sem ligar)

exports.simulateOpening = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    const leadName = String(req.query.leadName || 'Estúdio Exemplo').slice(0, 80);
    res.json({ opening: buildOpeningText(agent, leadName) });
  } catch (error) {
    next(error);
  }
};

exports.simulate = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    const message = String(req.body?.message || '').trim().slice(0, 600);
    if (!message) return res.status(400).json({ error: 'Escreva o que o cliente diria.' });

    invalidateProviders(req.userId);
    const result = await runAgentTurn({
      agent,
      leadName: String(req.body?.leadName || 'Estúdio Exemplo').slice(0, 80),
      transcript: asList(req.body?.transcript)
        .slice(-40)
        .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'lead', text: String(t.text || '').slice(0, 600), raw: t.raw })),
      userText: message,
      collected: req.body?.collected && typeof req.body.collected === 'object' ? req.body.collected : {},
      turnCount: clamp(req.body?.turnCount, 0, 60, 0)
    });
    res.json({ reply: result });
  } catch (error) {
    next(error);
  }
};

exports.testCall = async (req, res, next) => {
  try {
    const agent = await findOwnedAgent(req);
    invalidateProviders(req.userId);
    const ai = await getProviderCached(req.userId, agent.aiProvider);
    if (!ai) return res.status(400).json({ error: 'Nenhuma IA configurada. Cadastre a chave em Configurações > Inteligência Artificial.' });
    const callId = await startTestCall({ agent, phone: req.body?.phone });
    res.json({ success: true, callId });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ campanhas

exports.listCampaigns = async (req, res, next) => {
  try {
    const campaigns = await prisma.aiCallCampaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { agent: { select: { id: true, name: true } } }
    });
    res.json({ campaigns });
  } catch (error) {
    next(error);
  }
};

exports.previewAudience = async (req, res, next) => {
  try {
    const total = await countAudience(req.userId, req.body?.audienceFilter || {}, 'sms');
    res.json({ total });
  } catch (error) {
    next(error);
  }
};

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

exports.createCampaign = async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Informe o nome da campanha.' });

    const agent = await prisma.aiVoiceAgent.findFirst({ where: { id: body.agentId, userId: req.userId }, select: { id: true } });
    if (!agent) return res.status(400).json({ error: 'Escolha o agente de IA que fará as ligações.' });

    const audienceFilter = body.audienceFilter && typeof body.audienceFilter === 'object' ? body.audienceFilter : {};
    const total = await countAudience(req.userId, audienceFilter, 'sms');
    if (total === 0) return res.status(400).json({ error: 'Nenhum lead com telefone encontrado para esse público.' });

    if (body.callerNumberId) {
      const number = await prisma.callerNumber.findFirst({ where: { id: body.callerNumberId, userId: req.userId } });
      if (!number) return res.status(400).json({ error: 'O número de discagem escolhido não foi encontrado.' });
    }

    const windowStart = HHMM.test(body.windowStart || '') ? body.windowStart : '09:00';
    const windowEnd = HHMM.test(body.windowEnd || '') ? body.windowEnd : '18:00';
    const minDelaySeconds = clamp(body.minDelaySeconds, 0, 3600, 20);
    const maxDelaySeconds = Math.max(clamp(body.maxDelaySeconds, 0, 3600, 60), minDelaySeconds);

    const campaign = await prisma.aiCallCampaign.create({
      data: {
        userId: req.userId,
        name,
        agentId: agent.id,
        audienceFilter,
        callerNumberId: body.callerNumberId || null,
        concurrency: clamp(body.concurrency, 1, 3, 1),
        minDelaySeconds,
        maxDelaySeconds,
        windowStart,
        windowEnd,
        weekdaysOnly: toBool(body.weekdaysOnly, true),
        totalLeads: total
      }
    });
    res.status(201).json({ campaign });
  } catch (error) {
    next(error);
  }
};

exports.startCampaign = async (req, res, next) => {
  try {
    const campaign = await prisma.aiCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });

    validatePublicUrl();
    await getActiveTelephonyProvider(req.userId);

    const numbers = await prisma.callerNumber.count({ where: { userId: req.userId, isActive: true } });
    if (numbers === 0) return res.status(400).json({ error: 'Nenhum número de discagem ativo. Cadastre em Linhas > Números de Discagem.' });

    const agent = await prisma.aiVoiceAgent.findUnique({ where: { id: campaign.agentId }, select: { aiProvider: true } });
    invalidateProviders(req.userId);
    const ai = await getProviderCached(req.userId, agent?.aiProvider);
    if (!ai) return res.status(400).json({ error: 'Nenhuma IA configurada. Cadastre a chave em Configurações > Inteligência Artificial.' });

    await prisma.aiCallCampaign.update({ where: { id: campaign.id }, data: { status: 'discando', runningNote: 'Iniciando…' } });
    executeAiCampaign(campaign.id).catch((err) => console.error('Erro na campanha do agente IA:', err.message));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.pauseCampaign = async (req, res, next) => {
  try {
    const result = await prisma.aiCallCampaign.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { status: 'pausado', runningNote: 'Pausando após a ligação em andamento…' }
    });
    if (result.count === 0) return res.status(404).json({ error: 'Campanha não encontrada.' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.removeCampaign = async (req, res, next) => {
  try {
    const campaign = await prisma.aiCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
    if (campaign.isRunning || campaign.status === 'discando') {
      return res.status(400).json({ error: 'Pause a campanha antes de excluir.' });
    }
    await prisma.aiCallCampaign.delete({ where: { id: campaign.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.getCampaignCalls = async (req, res, next) => {
  try {
    const campaign = await prisma.aiCallCampaign.findFirst({ where: { id: req.params.id, userId: req.userId }, select: { id: true } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });

    const calls = await prisma.call.findMany({
      where: { aiCallCampaignId: campaign.id },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        toNumber: true,
        status: true,
        answeredAt: true,
        durationSeconds: true,
        createdAt: true,
        lead: { select: { name: true } },
        aiSession: { select: { id: true, outcome: true, summary: true, handoffStatus: true, turnCount: true, callbackAt: true } }
      }
    });
    res.json({ calls });
  } catch (error) {
    next(error);
  }
};

exports.getSession = async (req, res, next) => {
  try {
    const session = await prisma.aiCallSession.findFirst({
      where: { id: req.params.sessionId, userId: req.userId },
      select: {
        id: true,
        transcript: true,
        collected: true,
        summary: true,
        outcome: true,
        handoffStatus: true,
        handoffAt: true,
        callbackAt: true,
        callbackNote: true,
        isTest: true,
        createdAt: true
      }
    });
    if (!session) return res.status(404).json({ error: 'Conversa não encontrada.' });
    res.json({ session });
  } catch (error) {
    next(error);
  }
};

// Últimas ligações de teste (para ver o resultado da ligação para o seu celular).
exports.listTestSessions = async (req, res, next) => {
  try {
    const sessions = await prisma.aiCallSession.findMany({
      where: { userId: req.userId, isTest: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, leadId: true, outcome: true, summary: true, turnCount: true, handoffStatus: true, createdAt: true }
    });
    // Mostra onde o contato de teste está no CRM, para conferir se o fluxo funcionou.
    const cards = await prisma.crmCard.findMany({
      where: { leadId: { in: sessions.map((s) => s.leadId) } },
      select: { leadId: true, column: { select: { name: true } } }
    });
    const columnByLead = new Map(cards.map((c) => [c.leadId, c.column?.name]));
    res.json({
      sessions: sessions.map((s) => ({
        ...s,
        crmColumn: ['quente', 'morno', 'retorno_agendado'].includes(s.outcome) ? columnByLead.get(s.leadId) || null : null
      }))
    });
  } catch (error) {
    next(error);
  }
};
