// backend/src/controllers/campaignsController.js
const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');
const { fetchSiteCatalog } = require('../services/ai/voice/catalogService');
const { getActiveAiProvider } = require('../services/ai/aiProviderFactory');
const bot = require('../services/campaignBotService');

const SOURCE_KEYS = ['facebook_ads', 'google_ads', 'instagram', 'indicacao', 'site', 'cliente', 'organico', 'outro'];
const BOT_CONFIG_LIMITS = {
  persona: 80, company: 120, objective: 20, tone: 20, offer: 3000, audience: 600,
  rules: 3000, forbidden: 3000, faq: 3000, handoff: 1500, closing: 600
};

function text(value, max) {
  const v = String(value ?? '').trim();
  return v ? v.slice(0, max) : null;
}

function list(value, { max = 20, len = 80, lower = false } = {}) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  const out = [];
  for (const item of raw) {
    let v = String(item ?? '').trim().slice(0, len);
    if (lower) v = v.toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, max);
}

function cleanBotConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, max] of Object.entries(BOT_CONFIG_LIMITS)) {
    const v = text(value[key], max);
    if (v) out[key] = v;
  }
  if (out.objective && !bot.OBJECTIVES[out.objective]) delete out.objective;
  if (out.tone && !bot.TONES[out.tone]) delete out.tone;
  if (value.emojis === false) out.emojis = false;
  return Object.keys(out).length ? out : null;
}

function cleanRules(rules) {
  if (!rules || !Array.isArray(rules.steps)) return null;
  return {
    logic: rules.logic === 'ANY' ? 'ANY' : 'ALL',
    steps: rules.steps.slice(0, 30).map((s) => {
      const step = {
        id: String(s.id || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40),
        question: String(s.question || '').trim().slice(0, 300),
        type: ['number_min', 'number_max', 'boolean_true', 'one_of'].includes(s.type) ? s.type : 'boolean_true'
      };
      if (step.type === 'number_min') step.minValue = Number(s.minValue) || 0;
      if (step.type === 'number_max') step.maxValue = Number(s.maxValue) || 0;
      if (step.type === 'one_of') step.acceptedValues = list(s.acceptedValues, { max: 20, len: 80 });
      return step;
    }).filter((s) => s.id && s.question)
  };
}

/** Só os campos que o usuário pode alterar (nunca userId, id, etc.). */
function buildData(body, { partial }) {
  const data = {};
  const has = (k) => body[k] !== undefined;

  if (has('name')) data.name = text(body.name, 120);
  if (has('enterpriseName')) data.enterpriseName = text(body.enterpriseName, 120);
  if (has('active')) data.active = Boolean(body.active);
  if (has('botEnabled')) data.botEnabled = Boolean(body.botEnabled);
  if (has('isDefault')) data.isDefault = Boolean(body.isDefault);
  if (has('whatsappConnectionId')) data.whatsappConnectionId = text(body.whatsappConnectionId, 60);
  if (has('botPrompt')) data.botPrompt = text(body.botPrompt, 3000);
  if (has('firstMessage')) data.firstMessage = text(body.firstMessage, 600);
  if (has('aiProviderOverride')) data.aiProviderOverride = text(body.aiProviderOverride, 40);
  if (has('followUpEnabled')) data.followUpEnabled = Boolean(body.followUpEnabled);
  if (has('followUpDays')) data.followUpDays = Math.min(365, Math.max(1, parseInt(body.followUpDays, 10) || 7));
  if (has('nutritionDays')) data.nutritionDays = Math.min(730, Math.max(1, parseInt(body.nutritionDays, 10) || 30));
  if (has('followUpMessage')) data.followUpMessage = text(body.followUpMessage, 1500);
  if (has('nutritionMessage')) data.nutritionMessage = text(body.nutritionMessage, 1500);
  if (has('sourceType')) data.sourceType = SOURCE_KEYS.includes(body.sourceType) ? body.sourceType : 'outro';
  if (has('triggerKeywords')) data.triggerKeywords = list(body.triggerKeywords, { max: 20, len: 80 });
  if (has('adSourceIds')) data.adSourceIds = list(body.adSourceIds, { max: 30, len: 60 });
  if (has('botConfig')) data.botConfig = cleanBotConfig(body.botConfig) ?? Prisma.DbNull;
  if (has('catalogText')) data.catalogText = text(body.catalogText, 60000);
  if (has('catalogUrl')) {
    let url = text(body.catalogUrl, 500);
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    data.catalogUrl = url;
  }
  if (has('qualificationRules')) {
    const rules = cleanRules(body.qualificationRules);
    if (rules) data.qualificationRules = rules;
  }
  if (!partial && !data.qualificationRules) data.qualificationRules = { logic: 'ALL', steps: [] };
  return data;
}

/** O número escolhido precisa ser de uma conexão desta conta. */
async function validConnectionOrNull(userId, id) {
  if (!id) return null;
  const conn = await prisma.whatsappConnection.findFirst({ where: { id, userId }, select: { id: true } });
  return conn ? conn.id : null;
}

async function loadSiteCatalog(url) {
  try {
    const info = await fetchSiteCatalog(url);
    return { catalogWebText: info.text, catalogFetchedAt: new Date(), pages: info.pages, warning: null };
  } catch (error) {
    return { catalogWebText: null, catalogFetchedAt: null, pages: 0, warning: error.message };
  }
}

async function ensureSingleDefault(userId, keepId) {
  await prisma.campaign.updateMany({ where: { userId, isDefault: true, id: { not: keepId } }, data: { isDefault: false } });
}

function publicCampaign(c) {
  if (!c) return c;
  const { catalogWebText, ...rest } = c;
  return { ...rest, catalogWebChars: catalogWebText ? catalogWebText.length : 0 };
}

exports.list = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leads: true } } }
    });
    res.json({ campaigns: campaigns.map(publicCampaign) });
  } catch (error) {
    next(error);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ campaign: publicCampaign(campaign) });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const data = buildData(req.body || {}, { partial: false });
    if (!data.name) return res.status(400).json({ error: 'Nome da campanha é obrigatório' });

    if (data.whatsappConnectionId) data.whatsappConnectionId = await validConnectionOrNull(req.userId, data.whatsappConnectionId);

    let warning = null;
    if (data.catalogUrl) {
      const site = await loadSiteCatalog(data.catalogUrl);
      data.catalogWebText = site.catalogWebText;
      data.catalogFetchedAt = site.catalogFetchedAt;
      warning = site.warning;
    }

    const campaign = await prisma.campaign.create({ data: { ...data, userId: req.userId } });
    if (campaign.isDefault) await ensureSingleDefault(req.userId, campaign.id);
    res.status(201).json({ campaign: publicCampaign(campaign), catalogWarning: warning });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ error: 'Campanha não encontrada' });

    const data = buildData(req.body || {}, { partial: true });
    if (data.name === null) return res.status(400).json({ error: 'Nome da campanha é obrigatório' });

    if (data.whatsappConnectionId) data.whatsappConnectionId = await validConnectionOrNull(req.userId, data.whatsappConnectionId);

    let warning = null;
    if (data.catalogUrl !== undefined && data.catalogUrl !== existing.catalogUrl) {
      if (data.catalogUrl) {
        const site = await loadSiteCatalog(data.catalogUrl);
        data.catalogWebText = site.catalogWebText;
        data.catalogFetchedAt = site.catalogFetchedAt;
        warning = site.warning;
      } else {
        data.catalogWebText = null;
        data.catalogFetchedAt = null;
      }
    }

    const updated = await prisma.campaign.update({ where: { id: existing.id }, data });
    if (updated.isDefault) await ensureSingleDefault(req.userId, updated.id);
    res.json({ campaign: publicCampaign(updated), catalogWarning: warning });
  } catch (error) {
    next(error);
  }
};

exports.refreshCatalog = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (!campaign.catalogUrl) return res.status(400).json({ error: 'Esta campanha não tem o endereço do site cadastrado.' });

    const site = await loadSiteCatalog(campaign.catalogUrl);
    if (site.warning) return res.status(400).json({ error: site.warning });
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { catalogWebText: site.catalogWebText, catalogFetchedAt: site.catalogFetchedAt }
    });
    res.json({ success: true, pages: site.pages, chars: site.catalogWebText.length });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ relatório por campanha / origem

exports.report = async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(0, parseInt(req.query.days, 10) || 0));
    const where = { userId: req.userId, ...(days ? { createdAt: { gte: new Date(Date.now() - days * 86400000) } } : {}) };

    const [campaigns, byCampaign, bySource] = await Promise.all([
      prisma.campaign.findMany({ where: { userId: req.userId }, select: { id: true, name: true, sourceType: true, active: true, isDefault: true } }),
      prisma.lead.groupBy({ by: ['campaignId', 'status'], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['source'], where, _count: { _all: true } })
    ]);

    const rows = new Map();
    const row = (id, name, extra = {}) => {
      if (!rows.has(id)) rows.set(id, { id, name, total: 0, novos: 0, qualificados: 0, desqualificados: 0, ...extra });
      return rows.get(id);
    };
    for (const c of campaigns) row(c.id, c.name, { sourceType: c.sourceType, active: c.active, isDefault: c.isDefault });
    for (const g of byCampaign) {
      const r = g.campaignId ? row(g.campaignId, 'Campanha removida') : row('none', 'Sem campanha', { sourceType: 'organico' });
      const n = g._count._all;
      r.total += n;
      if (g.status === 'qualificado') r.qualificados += n;
      else if (g.status === 'desqualificado') r.desqualificados += n;
      else r.novos += n;
    }
    const result = [...rows.values()]
      .map((r) => ({ ...r, taxaQualificacao: r.qualificados + r.desqualificados > 0 ? Math.round((r.qualificados / (r.qualificados + r.desqualificados)) * 100) : null }))
      .sort((a, b) => b.total - a.total);

    res.json({
      days: days || null,
      campaigns: result,
      sources: bySource.map((s) => ({ source: s.source || 'sem_origem', count: s._count._all })).sort((a, b) => b.count - a.count)
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ prévia do prompt e teste do robô

/** Monta uma "campanha" a partir do formulário (ainda não salvo) e, se existir, junta o catálogo já lido do site. */
async function draftFromRequest(req) {
  const draft = buildData(req.body?.campaign || {}, { partial: false });
  draft.botConfig = cleanBotConfig(req.body?.campaign?.botConfig);
  draft.id = req.body?.campaign?.id || 'draft';
  draft.updatedAt = new Date();
  if (req.body?.campaign?.id) {
    const saved = await prisma.campaign.findFirst({ where: { id: req.body.campaign.id, userId: req.userId } });
    if (saved) {
      draft.id = saved.id;
      draft.catalogWebText = draft.catalogUrl === saved.catalogUrl ? saved.catalogWebText : null;
    }
  }
  return draft;
}

exports.previewPrompt = async (req, res, next) => {
  try {
    const campaign = await draftFromRequest(req);
    const source = SOURCE_KEYS.includes(req.body?.source) ? req.body.source : campaign.sourceType;
    const prompt = bot.buildSystemPrompt({ campaign, lead: { source, name: 'Maria' }, query: String(req.body?.query || '') });
    res.json({ prompt, chars: prompt.length });
  } catch (error) {
    next(error);
  }
};

const testHits = new Map();
function testLimited(userId) {
  const now = Date.now();
  const entry = testHits.get(userId);
  if (!entry || entry.resetAt <= now) {
    testHits.set(userId, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 40;
}

exports.testBot = async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 600);
    if (!message) return res.status(400).json({ error: 'Escreva o que o cliente diria.' });
    if (testLimited(req.userId)) return res.status(429).json({ error: 'Muitos testes seguidos. Aguarde alguns minutos.' });

    const campaign = await draftFromRequest(req);
    const source = SOURCE_KEYS.includes(req.body?.source) ? req.body.source : campaign.sourceType;
    const provider = await getActiveAiProvider(req.userId, campaign.aiProviderOverride);
    if (!provider) {
      return res.status(400).json({ error: 'Nenhuma IA configurada. Cadastre a chave em Configurações › Inteligência Artificial.' });
    }

    const history = (Array.isArray(req.body?.history) ? req.body.history : [])
      .slice(-16)
      .map((h) => ({ role: h.role === 'model' ? 'model' : 'user', text: String(h.text || '').slice(0, 1000) }))
      .filter((h) => h.text);
    const system = bot.buildSystemPrompt({
      campaign,
      lead: { source, name: 'Cliente teste' },
      query: `${history.filter((h) => h.role === 'user').slice(-2).map((h) => h.text).join(' ')} ${message}`
    });

    let raw;
    try {
      raw = await provider.generateReply(system, history, message);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.response?.data?.message || error.message;
      return res.status(502).json({ error: `A IA não respondeu: ${detail}` });
    }
    const reply = bot.parseBotReply(raw);
    const answers = bot.sanitizeAnswers(campaign.qualificationRules?.steps || [], reply.data);
    res.json({ reply: reply.text, collected: answers, handoff: reply.handoff });
  } catch (error) {
    next(error);
  }
};
