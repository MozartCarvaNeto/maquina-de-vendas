// backend/src/services/ai/voice/aiCallService.js
//
// 3º sistema de ligação: AGENTE DE VOZ COM IA.
// O sistema liga, a IA conversa (turno a turno, usando a voz e o
// reconhecimento de fala da Twilio), qualifica o lead, consulta o catálogo e,
// quando o lead está pronto, passa para o vendedor (transferindo a ligação
// ou mandando o contato por WhatsApp). Tudo que acontece vai para o CRM.
const crypto = require('crypto');
const prisma = require('../../../config/db');
const env = require('../../../config/env');
const { getActiveTelephonyProvider } = require('../../telephony/providerFactory');
const { resolveAudience, HEARTBEAT_STALE_MS } = require('../../broadcastService');
const whatsappDispatcher = require('../../whatsapp/whatsappDispatcher');
const { fetchSiteCatalog } = require('./catalogService');
const {
  getAgentCached,
  invalidateAgent,
  getProviderCached,
  fillVars,
  sanitizeSpeech,
  runAgentTurn,
  looksLikeVoicemail
} = require('./aiVoiceEngine');
const { applyPronunciation } = require('./pronunciation');

const TERMINAL_STATUSES = ['encerrada', 'ocupado', 'falhou', 'sem_resposta'];
const RING_TIMEOUT_SECONDS = 25;
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_SILENCE = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const asList = (value) => (Array.isArray(value) ? value : []);
const baseUrl = () => env.backendPublicUrl.replace(/\/$/, '');

// ------------------------------------------------------------------ horário (Brasília)

const SP_TZ = 'America/Sao_Paulo';

function spParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute)
  };
}

// Brasília não tem horário de verão desde 2019: UTC-3 fixo.
function spWallToDate(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute));
}

function toMinutes(hhmm, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isWithinCallWindow(campaign, now = new Date()) {
  const sp = spParts(now);
  if (campaign.weekdaysOnly && (sp.weekday === 0 || sp.weekday === 6)) return false;
  const start = toMinutes(campaign.windowStart, 9 * 60);
  const end = toMinutes(campaign.windowEnd, 18 * 60);
  return sp.minutes >= start && sp.minutes < end;
}

/** Próximo dia útil (pulando sábado/domingo) às `hour` h, daqui a `daysAhead` dias. */
function businessDayAt(hour, daysAhead, now = new Date()) {
  let date = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 3; i += 1) {
    const sp = spParts(date);
    if (sp.weekday !== 0 && sp.weekday !== 6) break;
    date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  const sp = spParts(date);
  return spWallToDate(sp.year, sp.month, sp.day, hour, 0);
}

// ------------------------------------------------------------------ utilidades

function toE164(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return `+${digits}`;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function emitToAccount(userId, event, payload) {
  const io = global.socketIoInstance;
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

function validatePublicUrl() {
  const url = String(env.backendPublicUrl || '');
  if (!/^https?:\/\//i.test(url) || /localhost|127\.0\.0\.1/i.test(url)) {
    const err = new Error(
      'BACKEND_PUBLIC_URL precisa ser um endereço público (a Twilio precisa alcançar seu servidor). Em testes locais use um túnel como ngrok; em produção use o domínio do seu servidor.'
    );
    err.status = 400;
    throw err;
  }
}

// ------------------------------------------------------------------ TwiML

function sayTag(text, agent) {
  const voice = agent.voice ? ` voice="${escapeXml(agent.voice)}"` : '';
  // Troca palavras em inglês (ex.: nome da empresa) pela grafia que a voz em português lê direito.
  const spoken = applyPronunciation(text, agent);
  return `<Say${voice} language="${escapeXml(agent.language || 'pt-BR')}">${escapeXml(spoken)}</Say>`;
}

// Os termos do glossário viram "dicas" para o reconhecimento de voz acertar
// nomes técnicos (ex.: "threadless", "ASTM F136", "labret").
function buildHints(agent) {
  const base = ['sim', 'não', 'pode ser', 'tenho interesse', 'atacado', 'catálogo', 'WhatsApp', 'orçamento', 'amanhã', 'segunda-feira'];
  const terms = asList(agent.glossary)
    .map((g) => String(g?.term || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length <= 60);
  const all = [...new Set([...base, ...terms, agent.companyName].filter(Boolean))];
  let out = '';
  for (const hint of all) {
    if (out.length + hint.length + 2 > 2800) break;
    out += out ? `, ${hint}` : hint;
  }
  return out;
}

function turnUrl(callId) {
  return `${baseUrl()}/api/ai-calls/webhook/turn?callId=${callId}`;
}

function buildGatherTwiml({ agent, text, callId }) {
  const action = turnUrl(callId);
  const hints = buildHints(agent);
  return `<Response>
  <Gather input="speech" language="${escapeXml(agent.language || 'pt-BR')}" speechTimeout="auto" timeout="6" actionOnEmptyResult="true" hints="${escapeXml(hints)}" action="${escapeXml(action)}" method="POST">
    ${sayTag(text, agent)}
  </Gather>
  <Redirect method="POST">${escapeXml(action)}</Redirect>
</Response>`;
}

function buildHangupTwiml(agent, text) {
  return `<Response>${text ? sayTag(text, agent) : ''}<Hangup/></Response>`;
}

function buildDialTwiml({ agent, text, callId, fromNumber, toPhone }) {
  const action = `${baseUrl()}/api/ai-calls/webhook/dial-result?callId=${callId}`;
  return `<Response>
  ${text ? sayTag(text, agent) : ''}
  <Dial answerOnBridge="true" timeout="25" callerId="${escapeXml(fromNumber)}" action="${escapeXml(action)}" method="POST">
    <Number>${escapeXml(toPhone)}</Number>
  </Dial>
</Response>`;
}

function buildOpeningText(agent, leadName) {
  let opening = sanitizeSpeech(fillVars(agent.openingScript, { leadName, agent }));
  if (agent.recordCalls) opening = `${opening} Esta ligação pode ser gravada.`;
  return opening;
}

// ------------------------------------------------------------------ WhatsApp / CRM

async function pickReadyWhatsappConnection(userId) {
  const rows = await prisma.whatsappConnection.findMany({
    where: { userId, status: 'conectado' },
    orderBy: { createdAt: 'asc' }
  });
  const ready = rows.filter((conn) => whatsappDispatcher.isReady(conn));
  if (ready.length === 0) return null;
  const chosen = ready[Math.floor(Math.random() * ready.length)];
  return whatsappDispatcher.loadConnectionForSending(chosen.id);
}

async function sendWhatsapp(userId, toPhone, text) {
  const connection = await pickReadyWhatsappConnection(userId);
  if (!connection) return { sent: false, reason: 'nenhum WhatsApp conectado' };
  await whatsappDispatcher.sendMessage(connection, toPhone, text);
  return { sent: true };
}

function collectedToLines(session, agent) {
  const labels = {};
  asList(agent?.qualificationFields).forEach((f) => {
    if (f?.key) labels[f.key] = f.label || f.key;
  });
  return Object.entries(session.collected || {}).map(([key, value]) => `- ${labels[key] || key}: ${value}`);
}

async function findColumn(userId, { id, name }) {
  if (id) {
    const byId = await prisma.crmColumn.findFirst({ where: { id, board: { userId } } });
    if (byId) return byId;
  }
  if (name) {
    const byName = await prisma.crmColumn.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, board: { userId } },
      orderBy: { board: { createdAt: 'asc' } }
    });
    if (byName) return byName;
  }
  return null;
}

async function resolveColumn(userId, agent, kind) {
  if (kind === 'warm') {
    const warm = await findColumn(userId, { name: 'Em Qualificação' });
    if (warm) return warm;
  }
  const hot = await findColumn(userId, { id: agent.crmColumnId, name: 'Qualificado' });
  if (hot) return hot;
  return prisma.crmColumn.findFirst({
    where: { board: { userId } },
    orderBy: [{ board: { createdAt: 'asc' } }, { position: 'asc' }]
  });
}

async function upsertCrmCard({ userId, lead, column, note, followUpAt, followUpNote, overrideFollowUp }) {
  const existing = await prisma.crmCard.findUnique({ where: { leadId: lead.id }, include: { column: true } });

  // Lead já fechado não é movido; só recebe a anotação.
  const keepColumn = existing && /fechad/i.test(existing.column.name);
  const targetColumnId = keepColumn ? existing.columnId : column.id;
  const position = keepColumn ? existing.position : await prisma.crmCard.count({ where: { columnId: targetColumnId } });
  const notes = existing?.notes ? `${existing.notes}\n\n${note}` : note;

  const followData = {};
  if (followUpAt && (overrideFollowUp || !existing?.followUpAt)) {
    followData.followUpAt = followUpAt;
    followData.followUpNote = followUpNote || null;
  }
  // Se o lead estava em "Perdidos" e voltou a conversar, ele sai de lá.
  const reactivated = existing && /perdid/i.test(existing.column.name) && !keepColumn;
  const lostReset = reactivated ? { lostAt: null, lostReason: null } : {};

  return prisma.crmCard.upsert({
    where: { leadId: lead.id },
    update: { columnId: targetColumnId, position, notes, ...followData, ...lostReset },
    create: { leadId: lead.id, columnId: targetColumnId, position, notes, ...followData }
  });
}

// ------------------------------------------------------------------ passagem ao vendedor

async function resolveHandoffTarget(agent) {
  if (agent.handoffAgentId) {
    const seller = await prisma.agent.findFirst({
      where: { id: agent.handoffAgentId, userId: agent.userId, isActive: true },
      select: { name: true, phoneNumber: true }
    });
    if (seller?.phoneNumber) return { phone: toE164(seller.phoneNumber), label: seller.name };
  }
  if (agent.handoffPhone) return { phone: toE164(agent.handoffPhone), label: 'Consultor' };
  return null;
}

function buildSellerMessage({ lead, session, agent, mode }) {
  const lines = [
    `🔥 *Lead quente pela IA — ${agent.name}*`,
    `*Contato:* ${lead.name}${lead.phone ? ` — ${lead.phone}` : ''}`
  ];
  if (session.summary) lines.push(`*Resumo:* ${session.summary}`);
  const collected = collectedToLines(session, agent);
  if (collected.length) lines.push('*Informações coletadas:*', ...collected);
  const digits = String(lead.phone || '').replace(/\D/g, '');
  if (mode === 'transfer') lines.push('📞 A ligação está sendo transferida para você agora. Atenda!');
  else if (digits) lines.push(`💬 Chame agora no WhatsApp: https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`);
  return lines.join('\n');
}

async function notifySeller({ lead, sessionId, agent, mode, target }) {
  if (!agent.notifySellerWhatsapp || !target?.phone) return;
  try {
    const session = await prisma.aiCallSession.findUnique({ where: { id: sessionId } });
    const result = await sendWhatsapp(agent.userId, target.phone, buildSellerMessage({ lead, session, agent, mode }));
    if (result.sent && mode !== 'transfer') {
      await prisma.aiCallSession.update({ where: { id: sessionId }, data: { handoffStatus: 'whatsapp_enviado' } });
    }
  } catch (error) {
    console.error(`⚠️ Aviso ao vendedor por WhatsApp falhou: ${error.message}`);
  }
}

/** Gera o TwiML da passagem (transferência ou "vou passar seu contato"). */
async function triggerHandoff({ call, session, agent, lead, say }) {
  const target = await resolveHandoffTarget(agent);
  const mode = agent.handoffMode === 'transfer' && target?.phone ? 'transfer' : 'whatsapp';

  const claim = await prisma.aiCallSession.updateMany({
    where: { id: session.id, handoffAt: null },
    data: {
      handoffAt: new Date(),
      handoffTarget: target?.phone || null,
      handoffStatus: mode === 'transfer' ? 'transferindo' : 'whatsapp_pendente'
    }
  });

  if (claim.count === 1 && !session.isTest) {
    notifySeller({ lead, sessionId: session.id, agent, mode, target }).catch(() => {});
  }

  if (mode === 'transfer') {
    return buildDialTwiml({ agent, text: say, callId: call.id, fromNumber: call.fromNumber, toPhone: target.phone });
  }
  return buildHangupTwiml(agent, say);
}

async function handleDialResult({ callId, dialStatus }) {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, aiSession: { select: { id: true, agentId: true } } } });
  if (!call?.aiSession) return '<Response><Hangup/></Response>';

  const connected = ['completed', 'answered'].includes(String(dialStatus || '').toLowerCase());
  await prisma.aiCallSession.update({
    where: { id: call.aiSession.id },
    data: { handoffStatus: connected ? 'conectada' : 'vendedor_indisponivel' }
  });
  if (connected) return '<Response><Hangup/></Response>';

  const agent = await getAgentCached(call.aiSession.agentId);
  return buildHangupTwiml(
    agent || { language: 'pt-BR' },
    'No momento nosso consultor não conseguiu atender, mas ele vai te chamar no WhatsApp em instantes. Muito obrigada pelo seu tempo!'
  );
}

// ------------------------------------------------------------------ conversa (cada fala do lead)

async function processTurn({ callId, speech, confidence }) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, userId: true, leadId: true, fromNumber: true, providerCallId: true }
  });
  const session = call ? await prisma.aiCallSession.findUnique({ where: { callId } }) : null;
  const agent = session?.agentId ? await getAgentCached(session.agentId) : null;
  if (!call || !session || !agent) return '<Response><Say language="pt-BR">Obrigado, até logo.</Say><Hangup/></Response>';

  const lead = await prisma.lead.findUnique({ where: { id: session.leadId }, select: { id: true, name: true, phone: true, userId: true } });
  const transcript = asList(session.transcript);
  const heard = String(speech || '').trim();
  const now = new Date();
  const nowIso = now.toISOString();

  // ---- silêncio ----
  if (!heard) {
    const silence = session.silenceCount + 1;
    if (silence >= MAX_SILENCE) {
      const bye = 'Não consegui te ouvir. Vou encerrar por aqui. Obrigada e até logo!';
      await prisma.aiCallSession.update({
        where: { id: session.id },
        data: {
          silenceCount: silence,
          outcome: session.outcome || (session.turnCount === 0 ? 'sem_resposta' : 'sem_conclusao'),
          transcript: [...transcript, { role: 'agent', text: bye, at: nowIso }]
        }
      });
      return buildHangupTwiml(agent, bye);
    }
    const again = session.turnCount === 0 ? 'Alô? Consegue me ouvir?' : 'Você ainda está aí? Pode repetir, por favor?';
    await prisma.aiCallSession.update({
      where: { id: session.id },
      data: { silenceCount: silence, transcript: [...transcript, { role: 'agent', text: again, at: nowIso }] }
    });
    return buildGatherTwiml({ agent, text: again, callId });
  }

  // ---- caixa postal ----
  if (session.turnCount <= 1 && looksLikeVoicemail(heard)) {
    await prisma.aiCallSession.update({
      where: { id: session.id },
      data: { outcome: 'caixa_postal', transcript: [...transcript, { role: 'lead', text: heard.slice(0, 500), at: nowIso }] }
    });
    return '<Response><Hangup/></Response>';
  }

  // ---- pergunta para a IA ----
  const leadTurn = { role: 'lead', text: heard.slice(0, 600), at: nowIso };
  let result;
  try {
    result = await runAgentTurn({
      agent,
      leadName: lead?.name,
      transcript,
      userText: heard,
      collected: session.collected || {},
      turnCount: session.turnCount,
      now
    });
  } catch (error) {
    console.error(`⚠️ IA da ligação ${callId}: ${error.message}`);
    const silence = session.silenceCount + 1;
    const failed = silence >= MAX_SILENCE || error.status === 400;
    const say = failed
      ? 'Desculpe, estou com uma instabilidade aqui. Um consultor vai entrar em contato com você em breve. Obrigada!'
      : 'Desculpe, tive um probleminha de conexão. Pode repetir, por favor?';
    await prisma.aiCallSession.update({
      where: { id: session.id },
      data: {
        silenceCount: silence,
        transcript: [...transcript, leadTurn, { role: 'agent', text: say, at: nowIso }],
        ...(failed ? { outcome: session.outcome || 'sem_conclusao' } : {})
      }
    });
    return failed ? buildHangupTwiml(agent, say) : buildGatherTwiml({ agent, text: say, callId });
  }

  const turnCount = session.turnCount + 1;
  let { action, say } = result;
  const outcome = result.outcome || session.outcome || null;

  // Limite de falas: encerra com educação.
  if (action === 'continue' && turnCount >= (agent.maxTurns || 14)) {
    action = 'end';
    say = `${say} Vou passar o que conversamos para um consultor. Muito obrigada e até logo!`.slice(0, 460);
  }

  const data = {
    transcript: [...transcript, leadTurn, { role: 'agent', text: say, raw: result.raw, at: nowIso }],
    collected: { ...(session.collected || {}), ...result.collected },
    summary: result.summary || session.summary,
    outcome: action === 'handoff' ? 'quente' : outcome,
    turnCount,
    silenceCount: 0
  };
  if (result.callbackAt) {
    data.callbackAt = result.callbackAt;
    data.callbackNote = result.callbackNote;
    if (!data.outcome || data.outcome === 'frio') data.outcome = 'retorno_agendado';
  }
  const updated = await prisma.aiCallSession.update({ where: { id: session.id }, data });

  if (action === 'handoff') {
    return triggerHandoff({ call, session: updated, agent, lead: lead || { name: 'Lead', phone: null }, say });
  }
  if (action === 'end') return buildHangupTwiml(agent, say);
  return buildGatherTwiml({ agent, text: say, callId });
}

// ------------------------------------------------------------------ resultado da ligação -> CRM

const OUTCOME_LABEL = {
  quente: 'Lead quente 🔥',
  morno: 'Lead morno',
  frio: 'Lead frio',
  nao_interessado: 'Sem interesse',
  optout: 'Pediu para não ligar mais',
  retorno_agendado: 'Retorno agendado',
  numero_errado: 'Número errado',
  caixa_postal: 'Caixa postal',
  sem_resposta: 'Sem resposta',
  sem_conclusao: 'Sem conclusão'
};

// ------------------------------------------------------------------ relatório da ligação

const NO_REPORT_OUTCOMES = ['optout', 'numero_errado', 'caixa_postal', 'sem_resposta'];

const NEXT_STEP = {
  quente: 'Chame o cliente agora: ele demonstrou interesse e está esperando o consultor.',
  morno: 'Retome o contato em até 2 dias úteis, enviando catálogo e condições.',
  retorno_agendado: 'Ligue ou chame no WhatsApp no horário combinado.',
  frio: 'Sem ação imediata.',
  nao_interessado: 'Sem ação — o cliente não tem interesse agora.',
  sem_conclusao: 'A conversa não terminou com uma conclusão: vale uma segunda tentativa.'
};

/** Resume a conversa: no máximo 14 falas (as 2 primeiras e as últimas), cada uma curta. */
function transcriptDigest(session) {
  const turns = asList(session.transcript).filter((t) => t && t.text);
  const fmt = (t) => `${t.role === 'agent' ? '🤖 IA' : '👤 Cliente'}: ${String(t.text).replace(/\s+/g, ' ').slice(0, 180)}`;
  if (turns.length <= 14) return turns.map(fmt);
  const omitted = turns.length - 14;
  return [...turns.slice(0, 2).map(fmt), `… (${omitted} falas omitidas) …`, ...turns.slice(-12).map(fmt)];
}

/**
 * Relatório básico para quem vai continuar o atendimento saber o que já foi conversado.
 * `markdown` = true usa *negrito* do WhatsApp; false é texto limpo para o Chat do sistema.
 */
function buildCallReport({ lead, session, agent, outcome, isTest, markdown }) {
  const b = (text) => (markdown ? `*${text}*` : text);
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: SP_TZ });
  const lines = [];

  lines.push(`📋 ${b(`Relatório da ligação — ${agent.name}`)}${isTest ? ' 🧪 TESTE' : ''}`);
  lines.push(`🕒 ${stamp}`);
  lines.push(`👤 ${b('Contato:')} ${lead.name}${lead.phone ? ` — ${lead.phone}` : ''}`);
  lines.push(`🎯 ${b('Resultado:')} ${OUTCOME_LABEL[outcome] || outcome}`);

  const collected = collectedToLines(session, agent);
  lines.push('');
  lines.push(`📝 ${b('Resumo:')} ${session.summary || (collected.length ? 'A IA não gerou um resumo; veja as informações coletadas abaixo.' : 'A IA não gerou um resumo desta conversa.')}`);

  if (collected.length) {
    lines.push('');
    lines.push(`✅ ${b('Informações coletadas:')}`);
    lines.push(...collected);
  }

  if (session.callbackAt) {
    const when = new Date(session.callbackAt).toLocaleString('pt-BR', { timeZone: SP_TZ });
    lines.push('');
    lines.push(`🗓️ ${b('Retorno combinado:')} ${when}${session.callbackNote ? ` — ${session.callbackNote}` : ''}`);
  }

  const handoffText = {
    conectada: 'ligação transferida e atendida pelo consultor',
    vendedor_indisponivel: 'o consultor NÃO atendeu a transferência — o cliente aguarda retorno',
    whatsapp_enviado: 'consultor avisado por WhatsApp',
    whatsapp_pendente: 'passagem ao consultor combinada com o cliente',
    transferindo: 'transferência em andamento'
  }[session.handoffStatus];
  if (handoffText) lines.push('', `🤝 ${b('Passagem ao consultor:')} ${handoffText}`);

  const digest = transcriptDigest(session);
  if (digest.length) {
    lines.push('', `💬 ${b('Conversa (resumida):')}`, ...digest);
  }

  lines.push('', `➡️ ${b('Próximo passo:')} ${NEXT_STEP[outcome] || NEXT_STEP.sem_conclusao}`);

  const digits = String(lead.phone || '').replace(/\D/g, '');
  if (digits) lines.push(`📱 Chamar no WhatsApp: https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`);
  if (isTest) lines.push('', '🧪 Ligação de teste: nada foi alterado no CRM nem enviado ao cliente.');

  return lines.join('\n');
}

/**
 * Entrega o relatório: (1) no histórico do contato em Conversas, como nota interna — assim quem abre o
 * chat vê o que a IA conversou antes de responder; (2) no WhatsApp do consultor. Na ligação de teste
 * o relatório vai para o consultor cadastrado ou, se não houver, para o próprio número de teste.
 */
async function deliverCallReport({ session, agent, lead, outcome, isTest }) {
  if (!session.turnCount) return;
  if (!isTest && NO_REPORT_OUTCOMES.includes(outcome)) return;

  const target = await resolveHandoffTarget(agent);

  const plain = buildCallReport({ lead, session, agent, outcome, isTest, markdown: false });
  const note = await prisma.message.create({
    data: { leadId: lead.id, direction: 'nota', channel: 'ia_relatorio', body: plain }
  });
  emitToAccount(lead.userId, 'whatsapp:message', { leadId: lead.id, message: note });

  const qualifies = ['quente', 'morno', 'retorno_agendado'].includes(outcome);
  const sellerPhone = isTest ? target?.phone || lead.phone : qualifies && agent.notifySellerWhatsapp ? target?.phone : null;
  if (!sellerPhone) return;

  const result = await sendWhatsapp(
    lead.userId,
    sellerPhone,
    buildCallReport({ lead, session, agent, outcome, isTest, markdown: true })
  );
  if (!result.sent) console.warn(`⚠️ Relatório da ligação não enviado ao consultor: ${result.reason}`);
}

/** Aplica no sistema o que a ligação concluiu (uma única vez por ligação). */
async function applyOutcomeEffects(sessionId) {
  const claim = await prisma.aiCallSession.updateMany({
    where: { id: sessionId, effectsApplied: false },
    data: { effectsApplied: true }
  });
  if (claim.count === 0) return null;

  const session = await prisma.aiCallSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;

  const agent = session.agentId ? await getAgentCached(session.agentId) : null;
  const lead = await prisma.lead.findUnique({ where: { id: session.leadId } });
  if (!agent || !lead) return null;

  const outcome = session.outcome || (session.turnCount > 0 ? 'sem_conclusao' : 'sem_resposta');

  // Relatório da conversa (nota no chat + WhatsApp do consultor). Falha aqui nunca derruba o fechamento.
  deliverCallReport({ session, agent, lead, outcome, isTest: !!session.isTest }).catch((error) =>
    console.error(`⚠️ Relatório da ligação falhou: ${error.message}`)
  );
  // Ligação de teste: só o relatório; não mexe em CRM, status do lead nem manda mensagem ao cliente.
  if (session.isTest) return null;
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: SP_TZ });
  const headerLines = [`🤖 Agente IA "${agent.name}" — ${stamp}`, `Resultado: ${OUTCOME_LABEL[outcome] || outcome}`];
  if (session.summary) headerLines.push(`Resumo: ${session.summary}`);
  const collectedLines = collectedToLines(session, agent);
  if (collectedLines.length) headerLines.push('Informações coletadas:', ...collectedLines);
  const note = headerLines.join('\n');

  const result = { outcome, crm: false };

  if (outcome === 'optout') {
    await prisma.lead.update({ where: { id: lead.id }, data: { optOut: true } });
    return result;
  }
  if (outcome === 'numero_errado') {
    if (!lead.tags.includes('numero_errado')) {
      await prisma.lead.update({ where: { id: lead.id }, data: { tags: { push: 'numero_errado' } } });
    }
    return result;
  }
  if (!['quente', 'morno', 'retorno_agendado'].includes(outcome)) return result;

  let followUpAt = null;
  let followUpNote = null;
  let overrideFollowUp = false;

  if (outcome === 'quente') {
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'qualificado' } });
    // Se o vendedor não atendeu ao vivo, o card já nasce com retorno para AGORA (vermelho no CRM).
    if (session.handoffStatus !== 'conectada') {
      followUpAt = new Date();
      followUpNote = 'Lead quente passado pela IA — fechar a venda.';
      overrideFollowUp = true;
    }
  } else if (outcome === 'retorno_agendado') {
    followUpAt = session.callbackAt || businessDayAt(10, 1);
    followUpNote = session.callbackNote || 'Retorno combinado durante a ligação com a IA.';
    overrideFollowUp = true;
  } else {
    followUpAt = businessDayAt(10, 2);
    followUpNote = 'Lead morno — retomar o contato.';
  }

  const column = await resolveColumn(lead.userId, agent, outcome === 'quente' ? 'hot' : 'warm');
  if (column) {
    await upsertCrmCard({ userId: lead.userId, lead, column, note, followUpAt, followUpNote, overrideFollowUp });
    result.crm = true;
    emitToAccount(lead.userId, 'crm:card_moved', { leadName: lead.name, toColumnId: column.id });
  }

  // WhatsApp para o lead: lead quente que não foi atendido ao vivo, e lead morno.
  const liveTransfer = outcome === 'quente' && session.handoffStatus === 'conectada';
  if (agent.leadWhatsappMessage && lead.phone && !liveTransfer && ['quente', 'morno'].includes(outcome)) {
    const text = fillVars(agent.leadWhatsappMessage, { leadName: lead.name, agent });
    sendWhatsapp(lead.userId, lead.phone, text).catch((error) =>
      console.warn(`⚠️ WhatsApp para ${lead.name} não enviado: ${error.message}`)
    );
  }

  emitToAccount(lead.userId, 'aicall:result', { leadId: lead.id, leadName: lead.name, outcome, campaignId: session.campaignId });
  return result;
}

/**
 * Fecha uma ligação do agente de IA (chamado quando a Twilio avisa que ela
 * terminou): atualiza contadores da campanha e aplica o resultado no CRM.
 */
async function finalizeAiCall(callId) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, aiCallCampaignId: true, answeredAt: true, aiSession: { select: { id: true, outcome: true, handoffStatus: true, turnCount: true } } }
  });
  if (!call) return;

  let outcome = call.aiSession?.outcome || null;

  if (call.aiSession) {
    if (!call.answeredAt) {
      outcome = 'sem_resposta';
    } else {
      if (!outcome) outcome = call.aiSession.turnCount > 0 ? 'sem_conclusao' : 'sem_resposta';
      await applyOutcomeEffects(call.aiSession.id).catch((error) => console.error('Erro ao aplicar resultado da IA:', error.message));
    }
    await prisma.aiCallSession.update({ where: { id: call.aiSession.id }, data: { outcome } }).catch(() => {});
  }

  if (call.aiCallCampaignId) {
    const inc = { calledCount: { increment: 1 } };
    if (!call.answeredAt) {
      inc.noAnswerCount = { increment: 1 };
    } else {
      inc.answeredCount = { increment: 1 };
      if (outcome === 'quente') inc.hotCount = { increment: 1 };
      else if (outcome === 'morno') inc.warmCount = { increment: 1 };
      else if (outcome === 'retorno_agendado') inc.callbackCount = { increment: 1 };
      else if (['nao_interessado', 'optout', 'frio', 'numero_errado'].includes(outcome)) inc.notInterestedCount = { increment: 1 };
      else if (['sem_resposta', 'caixa_postal'].includes(outcome)) inc.noAnswerCount = { increment: 1 };
      if (call.aiSession?.handoffStatus) inc.handoffCount = { increment: 1 };
    }
    await prisma.aiCallCampaign.update({ where: { id: call.aiCallCampaignId }, data: inc }).catch(() => {});
  }
}

// ------------------------------------------------------------------ fazer a ligação

async function pickCallerNumber(userId, callerNumberId) {
  if (callerNumberId) {
    const chosen = await prisma.callerNumber.findFirst({ where: { id: callerNumberId, isActive: true } });
    if (chosen) return chosen;
  }
  return prisma.callerNumber.findFirst({
    where: { userId, isActive: true },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
  });
}

async function placeAiCall({ campaign, agent, lead, provider, isTest = false }) {
  const callerNumber = await pickCallerNumber(agent.userId, campaign?.callerNumberId);
  if (!callerNumber) {
    const err = new Error('Nenhum número de discagem ativo. Cadastre em Linhas > Números de Discagem.');
    err.status = 400;
    err.fatal = true;
    throw err;
  }

  const callId = crypto.randomUUID();
  const opening = buildOpeningText(agent, lead.name);
  const rawOpening = JSON.stringify({ say: opening, action: 'continue', outcome: null, collected: {}, callbackAt: null, callbackNote: null, summary: '' });

  await prisma.call.create({
    data: {
      id: callId,
      userId: agent.userId,
      leadId: lead.id,
      provider: 'twilio',
      fromNumber: callerNumber.phoneNumber,
      toNumber: lead.phone,
      callerNumberId: callerNumber.id,
      aiCallCampaignId: campaign?.id || null,
      answeredBy: 'ia',
      status: 'iniciando',
      startedAt: new Date()
    }
  });
  await prisma.aiCallSession.create({
    data: {
      userId: agent.userId,
      callId,
      campaignId: campaign?.id || null,
      agentId: agent.id,
      leadId: lead.id,
      isTest,
      transcript: [{ role: 'agent', text: opening, raw: rawOpening, at: new Date().toISOString() }]
    }
  });

  try {
    const { providerCallId } = await provider.startCall({
      to: lead.phone,
      from: callerNumber.phoneNumber,
      statusCallbackUrl: `${baseUrl()}/api/ai-calls/webhook/status?callId=${callId}`,
      twiml: buildGatherTwiml({ agent, text: opening, callId }),
      ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
      timeLimitSeconds: agent.maxCallSeconds || 420,
      recordingStatusCallbackUrl: agent.recordCalls ? `${baseUrl()}/api/ai-calls/webhook/recording?callId=${callId}` : undefined
    });
    await prisma.call.update({ where: { id: callId }, data: { providerCallId } });
    await prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } });
    return callId;
  } catch (error) {
    await prisma.call.update({ where: { id: callId }, data: { status: 'falhou', endedAt: new Date() } });
    await finalizeAiCall(callId);
    throw error;
  }
}

async function waitForCallToFinish(callId, maxSeconds) {
  const deadline = Date.now() + (maxSeconds + 90) * 1000;
  while (Date.now() < deadline) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
    if (!call || TERMINAL_STATUSES.includes(call.status)) return true;
    await sleep(3000);
  }
  return false;
}

/** Ligação de teste: o agente liga para o seu próprio celular. */
async function startTestCall({ agent, phone }) {
  validatePublicUrl();
  const e164 = toE164(phone);
  if (!e164 || e164.length < 12) {
    const err = new Error('Informe o celular com DDD, por exemplo 11 99999-8888.');
    err.status = 400;
    throw err;
  }
  const provider = await getActiveTelephonyProvider(agent.userId);

  const TEST_TAG = 'teste-agente-ia';
  let lead = await prisma.lead.findFirst({ where: { userId: agent.userId, tags: { has: TEST_TAG } } });
  if (lead) {
    lead = await prisma.lead.update({ where: { id: lead.id }, data: { phone: e164, optOut: false } });
  } else {
    lead = await prisma.lead.create({
      data: {
        userId: agent.userId,
        name: 'Estúdio de Teste (Agente IA)',
        phone: e164,
        tags: [TEST_TAG],
        consentSource: 'teste_interno',
        status: 'novo'
      }
    });
  }
  return placeAiCall({ campaign: null, agent, lead, provider, isTest: true });
}

// ------------------------------------------------------------------ catálogo do site

async function refreshAgentCatalog(agentId) {
  const agent = await prisma.aiVoiceAgent.findUnique({ where: { id: agentId } });
  if (!agent?.catalogUrl) return null;
  const { text, pages, chars } = await fetchSiteCatalog(agent.catalogUrl);
  await prisma.aiVoiceAgent.update({ where: { id: agentId }, data: { catalogWebText: text, catalogFetchedAt: new Date() } });
  invalidateAgent(agentId);
  return { pages, chars };
}

// ------------------------------------------------------------------ campanha

async function heartbeat(campaignId, note) {
  await prisma.aiCallCampaign.update({
    where: { id: campaignId },
    data: { lastHeartbeatAt: new Date(), runningNote: note || null }
  });
}

async function executeAiCampaign(campaignId) {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const claim = await prisma.aiCallCampaign.updateMany({
    where: {
      id: campaignId,
      OR: [{ isRunning: false }, { isRunning: true, lastHeartbeatAt: { lt: staleBefore } }, { isRunning: true, lastHeartbeatAt: null }]
    },
    data: { isRunning: true, status: 'discando', lastHeartbeatAt: new Date(), runningNote: 'Iniciando…' }
  });
  if (claim.count === 0) return;

  try {
    const campaign = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return;

    invalidateAgent(campaign.agentId);
    const agent = await getAgentCached(campaign.agentId);
    if (!agent) throw new Error('O agente de IA desta campanha foi excluído.');

    const ai = await getProviderCached(agent.userId, agent.aiProvider);
    if (!ai) throw new Error('Nenhuma IA configurada. Cadastre a chave em Configurações > Inteligência Artificial.');

    if (agent.catalogUrl && (!agent.catalogFetchedAt || Date.now() - new Date(agent.catalogFetchedAt).getTime() > CATALOG_REFRESH_MS)) {
      await heartbeat(campaignId, 'Atualizando catálogo do site…');
      await refreshAgentCatalog(agent.id).catch((error) => console.warn(`⚠️ Catálogo do site não atualizado: ${error.message}`));
      invalidateAgent(agent.id);
    }
    const freshAgent = await getAgentCached(campaign.agentId);

    const provider = await getActiveTelephonyProvider(campaign.userId);
    const audience = await resolveAudience(campaign.userId, campaign.audienceFilter, 'sms', {
      select: { id: true, name: true, phone: true }
    });

    // Retomada sem repetir: quem já recebeu ligação desta campanha fica de fora.
    const already = await prisma.call.findMany({ where: { aiCallCampaignId: campaignId }, select: { leadId: true } });
    const calledIds = new Set(already.map((c) => c.leadId));
    const queue = audience.filter((lead) => !calledIds.has(lead.id));
    await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { totalLeads: audience.length } });

    let fatalError = null;
    let outsideWindow = false;

    const worker = async () => {
      while (queue.length > 0 && !fatalError && !outsideWindow) {
        const fresh = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
        if (!fresh || fresh.status !== 'discando') return;

        if (!isWithinCallWindow(campaign)) {
          outsideWindow = true;
          return;
        }

        const lead = queue.shift();
        const current = await prisma.lead.findUnique({ where: { id: lead.id }, select: { optOut: true } });
        if (!current || current.optOut) continue;

        try {
          await heartbeat(campaignId, `Ligando para ${lead.name}…`);
          const callId = await placeAiCall({ campaign, agent: freshAgent, lead, provider });
          const finished = await waitForCallToFinish(callId, freshAgent.maxCallSeconds || 420);
          if (!finished) {
            const stuck = await prisma.call.findUnique({ where: { id: callId } });
            if (stuck?.providerCallId) await provider.hangupCall({ providerCallId: stuck.providerCallId }).catch(() => {});
            await prisma.call.update({ where: { id: callId }, data: { status: 'encerrada', endedAt: new Date() } }).catch(() => {});
            await finalizeAiCall(callId);
          }
        } catch (error) {
          console.error(`❌ Ligação do agente IA para ${lead.name}: ${error.message}`);
          if (error.fatal || error.twilioCode === 20003) fatalError = error;
        }

        if (queue.length > 0 && !fatalError && !outsideWindow) {
          const wait = randomBetween(campaign.minDelaySeconds, campaign.maxDelaySeconds);
          await heartbeat(campaignId, `Próxima ligação em ${wait}s`);
          await sleep(wait * 1000);
        }
      }
    };

    const workers = Math.max(1, Math.min(campaign.concurrency || 1, 3));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    const finalState = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (fatalError) {
      await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { status: 'pausado', runningNote: `Pausada: ${fatalError.message}` } });
    } else if (outsideWindow && finalState?.status === 'discando') {
      await prisma.aiCallCampaign.update({
        where: { id: campaignId },
        data: {
          status: 'pausado',
          runningNote: `Fora do horário permitido (${campaign.windowStart}–${campaign.windowEnd}${campaign.weekdaysOnly ? ', seg a sex' : ''}). Clique em Retomar dentro da janela.`
        }
      });
    } else if (finalState?.status === 'discando') {
      await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { status: 'concluido', runningNote: 'Todas as ligações foram concluídas.' } });
    }
  } catch (error) {
    console.error(`❌ Campanha do agente IA ${campaignId} falhou:`, error.message);
    await prisma.aiCallCampaign
      .update({ where: { id: campaignId }, data: { status: 'pausado', runningNote: `Pausada: ${error.message}` } })
      .catch(() => {});
  } finally {
    await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { isRunning: false } }).catch(() => {});
  }
}

module.exports = {
  TERMINAL_STATUSES,
  validatePublicUrl,
  isWithinCallWindow,
  businessDayAt,
  toE164,
  buildOpeningText,
  buildGatherTwiml,
  buildHangupTwiml,
  buildDialTwiml,
  buildHints,
  processTurn,
  handleDialResult,
  finalizeAiCall,
  applyOutcomeEffects,
  startTestCall,
  refreshAgentCatalog,
  executeAiCampaign
};
