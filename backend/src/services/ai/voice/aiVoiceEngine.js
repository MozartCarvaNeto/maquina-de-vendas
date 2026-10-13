// backend/src/services/ai/voice/aiVoiceEngine.js
//
// "Cérebro" do agente de voz: monta as instruções (mercado, glossário,
// catálogo, critérios de qualificação e de passagem ao vendedor), conversa
// com a IA já configurada no app (Gemini ou OpenAI) e devolve, a cada fala do
// lead, o que o agente deve dizer + a avaliação do lead.
const prisma = require('../../../config/db');
const { getActiveAiProvider } = require('../aiProviderFactory');
const { buildCatalogContext, normalize } = require('./catalogService');

const LLM_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const ACTIONS = ['continue', 'handoff', 'end'];
const OUTCOMES = ['quente', 'morno', 'frio', 'nao_interessado', 'optout', 'retorno_agendado', 'numero_errado'];

// ------------------------------------------------------------------ caches
// O agente (com catálogo) e a IA são lidos do banco no máximo 1x a cada 5 min:
// durante a ligação cada fala vira uma chamada, e ler o catálogo inteiro toda
// vez gastaria tráfego do banco (egress) à toa.
const agentCache = new Map();
const providerCache = new Map();

async function getAgentCached(agentId) {
  const hit = agentCache.get(agentId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.agent;
  const agent = await prisma.aiVoiceAgent.findUnique({ where: { id: agentId } });
  if (agent) agentCache.set(agentId, { agent, at: Date.now() });
  return agent;
}

function invalidateAgent(agentId) {
  agentCache.delete(agentId);
}

async function getProviderCached(userId, providerName) {
  const key = `${userId}:${providerName || ''}`;
  const hit = providerCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.provider;
  const provider = await getActiveAiProvider(userId, providerName || undefined);
  if (provider) providerCache.set(key, { provider, at: Date.now() });
  return provider;
}

function invalidateProviders(userId) {
  for (const key of providerCache.keys()) {
    if (key.startsWith(`${userId}:`)) providerCache.delete(key);
  }
}

// ------------------------------------------------------------------ texto

function fillVars(template, { leadName, agent }) {
  return String(template || '')
    .replace(/{{\s*nome\s*}}/gi, leadName || '')
    .replace(/{{\s*empresa\s*}}/gi, agent.companyName || '')
    .replace(/{{\s*agente\s*}}/gi, agent.agentName || '');
}

/** Deixa o texto seguro e natural para a voz: sem markdown, emoji, links; tamanho limitado. */
function sanitizeSpeech(text, maxLength = 420) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function formatNowBrasilia(date = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(date);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

// ------------------------------------------------------------------ prompt

function buildSystemPrompt({ agent, leadName, catalogContext, collected, turnCount, now }) {
  const glossary = asList(agent.glossary).filter((g) => g && g.term);
  const fields = asList(agent.qualificationFields).filter((f) => f && f.key);

  const glossaryBlock = glossary.length
    ? glossary.map((g) => `- ${g.term}: ${g.meaning || ''}`).join('\n')
    : '- (sem glossário cadastrado)';

  const fieldsBlock = fields.length
    ? fields.map((f) => `- ${f.key}: ${f.label || f.key}${f.required ? ' (obrigatório)' : ''}`).join('\n')
    : '- (sem campos definidos: descubra o interesse e a necessidade da pessoa)';

  const remainingTurns = Math.max(0, (agent.maxTurns || 14) - turnCount);
  const closingHint =
    remainingTurns <= 2
      ? '\nATENÇÃO: a ligação está chegando ao limite de falas. Conclua agora: ou passe para o consultor (se o lead estiver pronto) ou encerre com educação combinando o próximo passo.'
      : '';

  return `Você é ${agent.agentName}, assistente VIRTUAL de vendas da ${agent.companyName}, fazendo uma LIGAÇÃO TELEFÔNICA para ${leadName || 'o cliente'}.
Data e hora atuais (Brasília): ${formatNowBrasilia(now)}.

OBJETIVO DA LIGAÇÃO
${fillVars(agent.objective, { leadName, agent })}

COMO FALAR (é uma conversa por voz, ao telefone)
- Frases curtas e naturais: no máximo 2 frases (até uns 35 palavras) por vez, e UMA pergunta por vez.
- Português do Brasil, simpático, seguro e profissional. Sem emojis, sem listas, sem markdown, sem links, sem siglas difíceis de pronunciar.
- Se a pessoa interromper, responda ao que ela disse antes de continuar o roteiro.
- Você é uma inteligência artificial: se perguntarem, diga com naturalidade que é a assistente virtual da ${agent.companyName}. Nunca finja ser humana.
- Nunca invente produtos, preços, medidas, estoque, prazos ou condições. Use SOMENTE o catálogo abaixo. Se não souber, diga que o consultor confirma.
- A transcrição vem de reconhecimento de voz e pode errar palavras (principalmente termos técnicos). Interprete pelo contexto; se não entender, peça com educação para repetir.
- Se a pessoa pedir para não receber mais ligações ou demonstrar irritação: peça desculpas, confirme que não ligará de novo e encerre (outcome "optout", action "end").
- Se for número errado ou a pessoa não for do negócio: peça desculpas e encerre (outcome "numero_errado", action "end").
- Se pedir para ligar em outro momento: combine dia e hora, confirme em voz alta e use outcome "retorno_agendado" com "callbackAt" (data e hora combinadas, com fuso -03:00).
- Se disser que não tem interesse, não insista mais de uma vez; agradeça e encerre (outcome "nao_interessado", action "end").

VOCABULÁRIO TÉCNICO DO MERCADO (${agent.market || 'geral'})
Use estes termos corretamente e entenda quando o cliente falar deles, mesmo que a transcrição escreva diferente:
${glossaryBlock}

O QUE VOCÊ PRECISA DESCOBRIR (qualificação)
${fieldsBlock}
Já coletado até agora: ${JSON.stringify(collected || {})}

CANAL PREFERIDO DE CONTATO
- Quando o lead demonstrar interesse (outcome quente ou morno), antes de se despedir pergunte, de forma natural, se ele prefere que o consultor continue pelo WhatsApp ou por ligação telefônica, e registre em "collected" a chave "canal_preferido" com o valor "whatsapp" ou "ligacao".
- Se ele preferir WhatsApp, NÃO use "handoff" (ele transfere a ligação): termine com action "end" e outcome "quente" ou "morno", avisando que o consultor vai chamá-lo no WhatsApp em breve.
- Se preferir ligação e os critérios do vendedor estiverem atendidos, use "handoff" normalmente.

QUANDO CHAMAR O VENDEDOR HUMANO
${fillVars(agent.handoffCriteria, { leadName, agent })}

${agent.extraInstructions ? `INSTRUÇÕES EXTRAS\n${fillVars(agent.extraInstructions, { leadName, agent })}\n` : ''}
CATÁLOGO / PRODUTOS (trechos relevantes para esta conversa)
${catalogContext}
${closingHint}

FORMATO DA RESPOSTA — responda SOMENTE com um JSON válido, sem nenhum texto fora dele:
{
  "say": "o que você vai falar agora",
  "action": "continue" | "handoff" | "end",
  "outcome": "quente" | "morno" | "frio" | "nao_interessado" | "optout" | "retorno_agendado" | "numero_errado" | null,
  "collected": { "chave": "valor" },
  "callbackAt": "2026-01-15T15:00:00-03:00" | null,
  "callbackNote": "o que foi combinado" | null,
  "summary": "resumo da conversa até aqui em no máximo 280 caracteres"
}
Regras do JSON:
- "continue": segue a conversa (padrão). "handoff": o lead está pronto e você vai passar para o vendedor — em "say" avise, com simpatia, que vai conectá-lo ou passar o contato ao consultor. "end": despedida final.
- "outcome" é a sua avaliação ATUAL do lead (quente = quer fechar ou receber proposta agora; morno = tem interesse mas sem pressa; frio = pouca abertura). Atualize a cada fala.
- "collected": só informações NOVAS que o lead acabou de dar, usando as chaves da qualificação.
- Use "handoff" somente quando os critérios do vendedor estiverem atendidos (e então outcome "quente").`;
}

// ------------------------------------------------------------------ histórico

// Os provedores de IA exigem alternar usuário/modelo começando pelo usuário.
function buildHistory(transcript) {
  const turns = asList(transcript).filter((t) => t && t.text);
  const merged = [{ role: 'user', text: '[A ligação foi atendida. Comece a conversa.]' }];

  for (const turn of turns) {
    const role = turn.role === 'agent' ? 'model' : 'user';
    const text =
      role === 'model'
        ? turn.raw || JSON.stringify({ say: turn.text, action: 'continue', outcome: null, collected: {}, callbackAt: null, callbackNote: null, summary: '' })
        : turn.text;
    const last = merged[merged.length - 1];
    if (last.role === role) last.text = `${last.text}\n${text}`;
    else merged.push({ role, text });
  }
  return merged;
}

// ------------------------------------------------------------------ resposta da IA

function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseModelReply(rawText, { now = new Date() } = {}) {
  const parsed = extractJson(rawText);

  if (!parsed || typeof parsed !== 'object') {
    // A IA respondeu em texto puro: usa como fala e segue a conversa.
    return {
      say: sanitizeSpeech(rawText) || 'Desculpe, pode repetir, por favor?',
      action: 'continue',
      outcome: null,
      collected: {},
      callbackAt: null,
      callbackNote: null,
      summary: null,
      raw: JSON.stringify({ say: sanitizeSpeech(rawText), action: 'continue', outcome: null, collected: {}, callbackAt: null, callbackNote: null, summary: '' })
    };
  }

  const action = ACTIONS.includes(parsed.action) ? parsed.action : 'continue';
  const outcome = OUTCOMES.includes(parsed.outcome) ? parsed.outcome : null;

  const collected = {};
  if (parsed.collected && typeof parsed.collected === 'object' && !Array.isArray(parsed.collected)) {
    Object.entries(parsed.collected)
      .slice(0, 20)
      .forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        collected[String(key).slice(0, 40)] = String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 200);
      });
  }

  let callbackAt = null;
  if (parsed.callbackAt) {
    const date = new Date(parsed.callbackAt);
    const maxFuture = now.getTime() + 120 * 24 * 60 * 60 * 1000;
    if (!Number.isNaN(date.getTime()) && date.getTime() > now.getTime() && date.getTime() < maxFuture) callbackAt = date;
  }

  let say = sanitizeSpeech(parsed.say);
  if (!say) {
    say = action === 'end' ? 'Muito obrigada pelo seu tempo. Tenha um ótimo dia!' : 'Desculpe, pode repetir, por favor?';
  }

  return {
    say,
    action,
    outcome,
    collected,
    callbackAt,
    callbackNote: parsed.callbackNote ? String(parsed.callbackNote).slice(0, 300) : null,
    summary: parsed.summary ? String(parsed.summary).slice(0, 300) : null,
    raw: JSON.stringify({
      say,
      action,
      outcome,
      collected,
      callbackAt: callbackAt ? callbackAt.toISOString() : null,
      callbackNote: parsed.callbackNote || null,
      summary: parsed.summary || ''
    })
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('A IA demorou demais para responder.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Gera a próxima fala do agente.
 * @param {object} p
 * @param {object} p.agent        - AiVoiceAgent
 * @param {string} p.leadName
 * @param {Array}  p.transcript   - [{ role: 'agent'|'lead', text, raw? }] até aqui (SEM a fala atual do lead)
 * @param {string} p.userText     - o que o lead acabou de falar
 * @param {object} p.collected    - dados já coletados
 * @param {number} p.turnCount
 */
async function runAgentTurn({ agent, leadName, transcript, userText, collected = {}, turnCount = 0, now = new Date() }) {
  const provider = await getProviderCached(agent.userId, agent.aiProvider);
  if (!provider) {
    const err = new Error('Nenhuma IA configurada. Cadastre a chave do Gemini ou OpenAI em Configurações > Inteligência Artificial.');
    err.status = 400;
    throw err;
  }

  const lastAgentText = [...asList(transcript)].reverse().find((t) => t.role === 'agent')?.text || '';
  const catalogContext = buildCatalogContext(agent, `${userText} ${lastAgentText}`);
  const systemPrompt = buildSystemPrompt({ agent, leadName, catalogContext, collected, turnCount, now });
  const history = buildHistory(transcript);

  const rawText = await withTimeout(provider.generateReply(systemPrompt, history, userText), LLM_TIMEOUT_MS);
  return parseModelReply(rawText, { now });
}

// Frases que indicam caixa postal / secretária eletrônica.
const VOICEMAIL_PHRASES = ['caixa postal', 'deixe sua mensagem', 'apos o sinal', 'nao esta disponivel', 'gravar sua mensagem', 'secretaria eletronica', 'mensagem apos'];
function looksLikeVoicemail(speech) {
  const heard = normalize(speech);
  return VOICEMAIL_PHRASES.some((phrase) => heard.includes(phrase));
}

module.exports = {
  getAgentCached,
  invalidateAgent,
  getProviderCached,
  invalidateProviders,
  fillVars,
  sanitizeSpeech,
  buildSystemPrompt,
  buildHistory,
  parseModelReply,
  runAgentTurn,
  looksLikeVoicemail,
  OUTCOMES
};
