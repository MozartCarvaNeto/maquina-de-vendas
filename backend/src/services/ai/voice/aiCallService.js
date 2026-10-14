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
const { getAiTelephonyProvider } = require('../../telephony/providerFactory');
const { speechify } = require('./geminiTtsService');
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
  looksLikeVoicemail,
  classifyCall
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

/** Próximo instante em que a janela de ligação abre (hoje, se ainda não abriu; senão o próximo dia permitido). */
function nextWindowStart(campaign, now = new Date()) {
  const start = toMinutes(campaign.windowStart, 9 * 60);
  for (let d = 0; d < 10; d += 1) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const sp = spParts(day);
    if (campaign.weekdaysOnly && (sp.weekday === 0 || sp.weekday === 6)) continue;
    const candidate = spWallToDate(sp.year, sp.month, sp.day, Math.floor(start / 60), start % 60);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + 60 * 60 * 1000);
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

const FALLBACK_VOICE = 'Polly.Camila-Neural';

function sayTag(text, agent) {
  // Voz do Gemini ("gemini:Kore"): o <Say> sai marcado e, antes de enviar à operadora, é trocado por um
  // <Play> com o áudio gerado (ver speechify). Se o Gemini falhar, fica a voz padrão abaixo.
  if (/^gemini:/i.test(String(agent.voice || ''))) {
    const geminiVoice = String(agent.voice).slice(7).trim() || 'Kore';
    const spokenGemini = applyPronunciation(text, agent, { useBuiltIn: false });
    return `<Say voice="${FALLBACK_VOICE}" language="${escapeXml(agent.language || 'pt-BR')}" data-tts="gemini:${escapeXml(geminiVoice)}|${escapeXml(agent.userId || '')}">${escapeXml(spokenGemini)}</Say>`;
  }
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

/**
 * `protect: true` = a fala NÃO pode ser interrompida: o <Say> fica FORA do <Gather>, então o cliente
 * falando por cima não corta a fala (o Twilio só começa a ouvir depois que ela termina). É usado na
 * apresentação inicial, que precisa sempre ser dita por inteiro.
 */
function buildGatherTwiml({ agent, text, callId, protect = false }) {
  const action = turnUrl(callId);
  const hints = buildHints(agent);
  const gatherAttrs = `input="speech" language="${escapeXml(agent.language || 'pt-BR')}" speechTimeout="auto" timeout="6" actionOnEmptyResult="true" hints="${escapeXml(hints)}" action="${escapeXml(action)}" method="POST"`;
  if (protect) {
    return `<Response>
  ${sayTag(text, agent)}
  <Gather ${gatherAttrs}></Gather>
  <Redirect method="POST">${escapeXml(action)}</Redirect>
</Response>`;
  }
  return `<Response>
  <Gather ${gatherAttrs}>
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
  // A abertura é exatamente o que está no "Roteiro da ligação" do agente (sem frase fixa do sistema).
  let opening = sanitizeSpeech(fillVars(agent.openingScript, { leadName, agent }), 800);
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

/**
 * `leadId` (opcional): registra a mensagem no Chat do contato (canal "ia_whatsapp") e guarda qual
 * número de WhatsApp foi usado — assim o vendedor responde pelo mesmo número, sem escolher de novo.
 */
async function sendWhatsapp(userId, toPhone, text, { leadId } = {}) {
  const connection = await pickReadyWhatsappConnection(userId);
  if (!connection) return { sent: false, reason: 'nenhum WhatsApp conectado' };
  await whatsappDispatcher.sendMessage(connection, toPhone, text);
  if (leadId) {
    try {
      const saved = await prisma.message.create({
        data: { leadId, direction: 'saida', channel: 'ia_whatsapp', body: text }
      });
      await prisma.lead.update({ where: { id: leadId }, data: { lastConnectionId: connection.id } });
      emitToAccount(userId, 'whatsapp:message', { leadId, message: saved });
    } catch (error) {
      console.warn(`⚠️ Mensagem enviada, mas não registrada no chat: ${error.message}`);
    }
  }
  return { sent: true };
}

/** Canal que o cliente escolheu na ligação ("whatsapp" | "call" | null). */
function preferredChannelOf(session) {
  const raw = String(session?.collected?.canal_preferido || '').toLowerCase();
  if (/whats|zap|mensag|texto/.test(raw)) return 'whatsapp';
  if (/lig|fone|telefon|call|voz/.test(raw)) return 'call';
  return null;
}

function collectedToLines(session, agent) {
  const labels = { canal_preferido: 'Canal preferido de contato' };
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

/** Se a conta ainda não tem nenhum quadro de CRM, cria o padrão (antes o card simplesmente não era criado). */
async function ensureDefaultBoard(userId) {
  const has = await prisma.crmColumn.findFirst({ where: { board: { userId } }, select: { id: true } });
  if (has) return;
  await prisma.crmBoard.create({
    data: {
      userId,
      name: 'Funil Principal',
      columns: {
        create: [
          { name: 'Novos', position: 0, color: '#00b4d8' },
          { name: 'Em Qualificação', position: 1, color: '#48cae4' },
          { name: 'Qualificado', position: 2, color: '#0096c7' },
          { name: 'Em Negociação', position: 3, color: '#0077b6' },
          { name: 'Fechado', position: 4, color: '#22c55e' },
          { name: 'Perdido', position: 5, color: '#ef4444' }
        ]
      }
    }
  });
}

async function resolveColumn(userId, agent, kind) {
  await ensureDefaultBoard(userId);
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

/**
 * Cliente que RECUSOU: card vai para a coluna "Perdidos", o lead fica com status "perdido"
 * e deixa de ser chamado nas campanhas. Cliente já "Fechado" não é mexido.
 */
async function markLeadLost({ userId, lead, reason, note }) {
  await ensureDefaultBoard(userId);
  const existing = await prisma.crmCard.findUnique({ where: { leadId: lead.id }, include: { column: true } });
  if (existing && /fechad/i.test(existing.column.name)) return null;

  let boardId = existing?.column?.boardId;
  if (!boardId) {
    const board = await prisma.crmBoard.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    boardId = board?.id;
  }
  if (!boardId) return null;

  let lostColumn = await prisma.crmColumn.findFirst({
    where: { boardId, name: { contains: 'perdid', mode: 'insensitive' } },
    orderBy: { position: 'asc' }
  });
  if (!lostColumn) {
    const total = await prisma.crmColumn.count({ where: { boardId } });
    lostColumn = await prisma.crmColumn.create({ data: { boardId, name: 'Perdidos', color: '#ef4444', position: total } });
  }

  const position = await prisma.crmCard.count({ where: { columnId: lostColumn.id } });
  const notes = existing?.notes ? `${existing.notes}\n\n${note}` : note;
  const lostData = { columnId: lostColumn.id, position, notes, lostAt: existing?.lostAt || new Date(), lostReason: reason, followUpAt: null, followUpNote: null };

  if (existing && existing.columnId !== lostColumn.id) {
    await prisma.crmCard.updateMany({ where: { columnId: existing.columnId, position: { gt: existing.position } }, data: { position: { decrement: 1 } } });
  }
  await prisma.crmCard.upsert({
    where: { leadId: lead.id },
    update: lostData,
    create: { leadId: lead.id, ...lostData }
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'perdido' } });
  emitToAccount(userId, 'crm:card_moved', { leadName: lead.name, toColumnId: lostColumn.id });
  return lostColumn;
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

/** Abertura da ligação para as operadoras que consultam um endereço quando o cliente atende (Telnyx, Jambonz). */
async function handleAnswerCall(callId) {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, aiSession: true } });
  const session = call?.aiSession;
  const agent = session?.agentId ? await getAgentCached(session.agentId) : null;
  if (!session || !agent) return '<Response><Hangup/></Response>';
  const opening = asList(session.transcript).find((t) => t.role === 'agent')?.text || buildOpeningText(agent, 'cliente');
  return buildGatherTwiml({ agent, text: opening, callId, protect: true });
}

// ------------------------------------------------------------------ conversa (cada fala do lead)

async function processTurn({ callId, speech, confidence }) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, userId: true, leadId: true, fromNumber: true, providerCallId: true, answeredAt: true }
  });
  const session = call ? await prisma.aiCallSession.findUnique({ where: { callId } }) : null;
  const agent = session?.agentId ? await getAgentCached(session.agentId) : null;
  if (!call || !session || !agent) return '<Response><Say language="pt-BR">Obrigado, até logo.</Say><Hangup/></Response>';

  // Se a pessoa está falando, a ligação foi atendida — não depende do aviso da Twilio.
  if (!call.answeredAt) {
    prisma.call.update({ where: { id: call.id }, data: { answeredAt: new Date(), status: 'atendida' } }).catch(() => {});
  }

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
  if (session.turnCount <= 2 && looksLikeVoicemail(heard)) {
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

  // A IA percebeu que é caixa postal/secretária: só desliga (não é recusa; a campanha tenta de novo depois).
  if (result.outcome === 'caixa_postal') {
    await prisma.aiCallSession.update({
      where: { id: session.id },
      data: { outcome: 'caixa_postal', transcript: [...transcript, leadTurn] }
    });
    return '<Response><Hangup/></Response>';
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
  if (action === 'end') {
    // Despedida da IA: aplica o resultado já, sem esperar o aviso de "ligação encerrada" da Twilio.
    const pending = applyOutcomeEffects(session.id)
      .catch((error) => console.error('Erro ao aplicar resultado da IA:', error.message))
      .finally(() => effectsInFlight.delete(session.id));
    effectsInFlight.set(session.id, pending);
    return buildHangupTwiml(agent, say);
  }
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
function buildCallReport({ lead, session, agent, outcome, isTest, markdown, effects }) {
  const b = (text) => (markdown ? `*${text}*` : text);
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: SP_TZ });
  const lines = [];

  lines.push(`📋 ${b(`Relatório da ligação — ${agent.name}`)}${isTest ? ' 🧪 TESTE' : ''}`);
  lines.push(`🕒 ${stamp}`);
  lines.push(`👤 ${b('Contato:')} ${lead.name}${lead.phone ? ` — ${lead.phone}` : ''}`);
  lines.push(`🎯 ${b('Resultado:')} ${OUTCOME_LABEL[outcome] || outcome}`);
  const preferred = effects?.preferred || preferredChannelOf(session);
  if (preferred) lines.push(`📲 ${b('Canal preferido do cliente:')} ${preferred === 'call' ? 'LIGAÇÃO' : 'WhatsApp'}`);

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

  if (effects) {
    lines.push('');
    if (effects.lostColumn) {
      lines.push(`📇 ${b('CRM:')} cliente recusou — movido para "${effects.lostColumn}" e não será chamado novamente.`);
    } else if (effects.crmAdded) {
      lines.push(`📇 ${b('CRM:')} contato adicionado na coluna "${effects.crmColumn}" com este relatório na anotação.`);
    } else {
      lines.push(`📇 ${b('CRM:')} contato NÃO adicionado. ${effects.remark || ''}`.trim());
    }
    if (effects.leadWhatsapp) lines.push(`💬 ${b('WhatsApp ao cliente:')} mensagem de continuidade enviada.`);
    if (effects.queued) lines.push(`📞 ${b('Discador:')} contato colocado na fila para ligação.`);
  }

  const digest = transcriptDigest(session);
  if (digest.length) {
    lines.push('', `💬 ${b('Conversa (resumida):')}`, ...digest);
  }

  let nextStep = NEXT_STEP[outcome] || NEXT_STEP.sem_conclusao;
  if (['quente', 'morno'].includes(outcome) && preferred === 'call') nextStep = 'O cliente pediu LIGAÇÃO: ligue para ele' + (outcome === 'quente' ? ' agora.' : ' em até 2 dias úteis.');
  else if (['quente', 'morno'].includes(outcome) && preferred === 'whatsapp') nextStep = 'O cliente prefere WhatsApp: chame-o por lá' + (outcome === 'quente' ? ' agora.' : ' em até 2 dias úteis.');
  lines.push('', `➡️ ${b('Próximo passo:')} ${nextStep}`);

  const digits = String(lead.phone || '').replace(/\D/g, '');
  if (digits) lines.push(`📱 Chamar no WhatsApp: https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`);
  if (isTest) lines.push('', '🧪 Ligação de teste: o fluxo foi aplicado de verdade ao contato de teste (seu celular). Apague o card de teste no CRM quando terminar.');

  return lines.join('\n');
}

/**
 * Entrega o relatório: (1) no histórico do contato em Conversas, como nota interna — assim quem abre o
 * chat vê o que a IA conversou antes de responder; (2) no WhatsApp do consultor. Na ligação de teste
 * o relatório vai para o consultor cadastrado ou, se não houver, para o próprio número de teste.
 */
async function deliverCallReport({ session, agent, lead, outcome, isTest, effects }) {
  if (!session.turnCount) return;
  if (!isTest && NO_REPORT_OUTCOMES.includes(outcome)) return;

  const target = await resolveHandoffTarget(agent);

  const plain = buildCallReport({ lead, session, agent, outcome, isTest, markdown: false, effects });
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
    buildCallReport({ lead, session, agent, outcome, isTest, markdown: true, effects })
  );
  if (!result.sent) console.warn(`⚠️ Relatório da ligação não enviado ao consultor: ${result.reason}`);
}

/**
 * Aplica no sistema o que a ligação concluiu (uma única vez por ligação) — IGUAL para ligação de teste
 * e de campanha real, para você validar o fluxo inteiro antes de rodar uma campanha:
 *  - lead quente / morno / retorno agendado entra no CRM com o relatório na anotação;
 *  - guarda o canal que o cliente prefere (WhatsApp ou ligação) no contato;
 *  - manda o WhatsApp de continuidade ao cliente (se o cliente não preferir ligação);
 *  - registra o relatório no chat e avisa o consultor por WhatsApp.
 * Na ligação de teste o "cliente" é o seu próprio celular, e tudo vem marcado com 🧪 TESTE.
 */
const effectsInFlight = new Map(); // sessionId -> Promise (resultado sendo aplicado)

/**
 * Garante um resultado confiável antes de aplicar no CRM:
 *  - se o "cliente" era uma gravação (caixa postal), vira caixa_postal — nunca recusa/Perdidos;
 *  - se a IA terminou sem classificar (ou a pessoa desligou no meio), uma análise da transcrição decide.
 */
async function resolveFinalOutcome(session, agent, lead) {
  const turns = asList(session.transcript);
  const leadTurns = turns.filter((t) => t && t.role === 'lead' && t.text);
  const data = {};

  if (leadTurns.some((t) => looksLikeVoicemail(t.text)) && leadTurns.length <= 3) {
    data.outcome = 'caixa_postal';
  } else if (leadTurns.length > 0 && (!session.outcome || session.outcome === 'sem_conclusao')) {
    try {
      const verdict = await classifyCall({ agent, leadName: lead.name, transcript: turns });
      if (verdict) {
        data.outcome = verdict.outcome;
        if (!session.summary && verdict.summary) data.summary = verdict.summary;
        if (verdict.canal && !session.collected?.canal_preferido) {
          data.collected = { ...(session.collected || {}), canal_preferido: verdict.canal };
        }
      }
    } catch (error) {
      console.warn(`⚠️ Não foi possível classificar a ligação ${session.callId}: ${error.message}`);
    }
  }

  if (!Object.keys(data).length) return session;
  return prisma.aiCallSession.update({ where: { id: session.id }, data });
}

async function applyOutcomeEffects(sessionId) {
  const claim = await prisma.aiCallSession.updateMany({
    where: { id: sessionId, effectsApplied: false },
    data: { effectsApplied: true }
  });
  if (claim.count === 0) return null;

  let session = await prisma.aiCallSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;

  const agent = session.agentId ? await getAgentCached(session.agentId) : null;
  const lead = await prisma.lead.findUnique({ where: { id: session.leadId } });
  if (!agent || !lead) return null;

  session = await resolveFinalOutcome(session, agent, lead);

  const isTest = !!session.isTest;
  const outcome = session.outcome || (session.turnCount > 0 ? 'sem_conclusao' : 'sem_resposta');
  const preferred = preferredChannelOf(session);
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: SP_TZ });

  const headerLines = [
    `🤖 Agente IA "${agent.name}"${isTest ? ' 🧪 TESTE' : ''} — ${stamp}`,
    `Resultado: ${OUTCOME_LABEL[outcome] || outcome}`
  ];
  if (preferred) headerLines.push(`Canal preferido do cliente: ${preferred === 'call' ? 'LIGAÇÃO' : 'WhatsApp'}`);
  if (session.summary) headerLines.push(`Resumo: ${session.summary}`);
  const collectedLines = collectedToLines(session, agent);
  if (collectedLines.length) headerLines.push('Informações coletadas:', ...collectedLines);
  const note = headerLines.join('\n');

  // O que realmente foi feito — aparece no relatório para você conferir.
  const effects = { crmColumn: null, crmAdded: false, leadWhatsapp: false, queued: false, preferred, remark: null };

  try {
    if (outcome === 'optout') {
      await prisma.lead.update({ where: { id: lead.id }, data: { optOut: true } });
      effects.remark = 'Contato marcado para não receber mais ligações.';
      const lost = await markLeadLost({ userId: lead.userId, lead, reason: 'Pediu para não receber ligações (IA)', note });
      if (lost) effects.lostColumn = lost.name;
    } else if (outcome === 'nao_interessado') {
      const lost = await markLeadLost({ userId: lead.userId, lead, reason: 'Recusou na ligação com a IA', note });
      if (lost) {
        effects.lostColumn = lost.name;
        effects.remark = `Cliente recusou: movido para "${lost.name}" e não receberá novas ligações.`;
      } else {
        effects.remark = 'Cliente recusou, mas não foi possível movê-lo para Perdidos.';
      }
    } else if (outcome === 'numero_errado') {
      if (!lead.tags.includes('numero_errado')) {
        await prisma.lead.update({ where: { id: lead.id }, data: { tags: { push: 'numero_errado' } } });
      }
      effects.remark = 'Número marcado como errado.';
    } else if (!['quente', 'morno', 'retorno_agendado'].includes(outcome)) {
      effects.remark = `Resultado "${OUTCOME_LABEL[outcome] || outcome}" não entra no CRM (só entram lead quente, morno ou retorno agendado).`;
    } else {
      let followUpAt = null;
      let followUpNote = null;
      let overrideFollowUp = false;
      const leadUpdate = {};

      if (preferred) leadUpdate.preferredChannel = preferred;

      if (outcome === 'quente') {
        leadUpdate.status = 'qualificado';
        // Se o vendedor não atendeu ao vivo, o card já nasce com retorno para AGORA (vermelho no CRM).
        if (session.handoffStatus !== 'conectada') {
          followUpAt = new Date();
          followUpNote = `Lead quente passado pela IA — ${preferred === 'call' ? 'LIGAR' : 'chamar no WhatsApp'} e fechar a venda.`;
          overrideFollowUp = true;
        }
      } else if (outcome === 'retorno_agendado') {
        followUpAt = session.callbackAt || businessDayAt(10, 1);
        followUpNote = session.callbackNote || 'Retorno combinado durante a ligação com a IA.';
        overrideFollowUp = true;
      } else {
        followUpAt = businessDayAt(10, 2);
        followUpNote = `Lead morno — retomar o contato${preferred === 'call' ? ' por ligação' : ''}.`;
      }

      if (Object.keys(leadUpdate).length) {
        await prisma.lead.update({ where: { id: lead.id }, data: leadUpdate });
      }

      const column = await resolveColumn(lead.userId, agent, outcome === 'quente' ? 'hot' : 'warm');
      if (column) {
        await upsertCrmCard({ userId: lead.userId, lead, column, note, followUpAt, followUpNote, overrideFollowUp });
        effects.crmAdded = true;
        effects.crmColumn = column.name;
        emitToAccount(lead.userId, 'crm:card_moved', { leadName: lead.name, toColumnId: column.id });
      } else {
        effects.remark = 'Não foi possível criar o card: nenhuma coluna de CRM encontrada.';
      }

      // Cliente que prefere LIGAÇÃO entra na fila do discador (só em campanha real; no teste o "cliente" é você).
      if (preferred === 'call' && lead.phone && !isTest) {
        const inQueue = await prisma.callQueueItem.findFirst({
          where: { leadId: lead.id, status: { in: ['pendente', 'discando'] } }
        });
        if (!inQueue) {
          await prisma.callQueueItem.create({ data: { userId: lead.userId, leadId: lead.id, status: 'pendente' } });
          effects.queued = true;
        }
      }

      // WhatsApp para o cliente: lead quente que não foi atendido ao vivo, e lead morno.
      // Quem pediu ligação não recebe mensagem — o consultor vai ligar.
      const liveTransfer = outcome === 'quente' && session.handoffStatus === 'conectada';
      if (agent.leadWhatsappMessage && lead.phone && !liveTransfer && preferred !== 'call' && ['quente', 'morno'].includes(outcome)) {
        const text = fillVars(agent.leadWhatsappMessage, { leadName: lead.name, agent });
        const sent = await sendWhatsapp(lead.userId, lead.phone, text, { leadId: lead.id }).catch((error) => ({
          sent: false,
          reason: error.message
        }));
        effects.leadWhatsapp = !!sent?.sent;
        if (!sent?.sent) console.warn(`⚠️ WhatsApp para ${lead.name} não enviado: ${sent?.reason}`);
      }
    }
  } catch (error) {
    console.error(`⚠️ Erro ao aplicar o resultado da ligação ${session.callId}: ${error.message}`);
    effects.remark = `Erro ao aplicar no CRM: ${error.message}`;
  }

  // Relatório (nota no chat + WhatsApp do consultor). Falha aqui nunca derruba o fechamento.
  await deliverCallReport({ session, agent, lead, outcome, isTest, effects }).catch((error) =>
    console.error(`⚠️ Relatório da ligação falhou: ${error.message}`)
  );

  emitToAccount(lead.userId, 'aicall:result', { leadId: lead.id, leadName: lead.name, outcome, campaignId: session.campaignId });
  return { outcome, crm: effects.crmAdded };
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

  // "Atendida" = a Twilio avisou que atendeu OU já houve conversa. Antes só valia o aviso da Twilio; quando
  // ele não chegava, a ligação era tratada como "sem resposta" e o resultado nunca ia para o CRM.
  const answered = !!call.answeredAt || (call.aiSession?.turnCount || 0) > 0;

  if (call.aiSession) {
    if (!answered) {
      outcome = 'sem_resposta';
    } else {
      if (!call.answeredAt) {
        await prisma.call.update({ where: { id: call.id }, data: { answeredAt: new Date() } }).catch(() => {});
      }
      if (!outcome) outcome = call.aiSession.turnCount > 0 ? 'sem_conclusao' : 'sem_resposta';
      await applyOutcomeEffects(call.aiSession.id).catch((error) => console.error('Erro ao aplicar resultado da IA:', error.message));
    }
    // O resultado pode ter sido refinado dentro de applyOutcomeEffects (caixa postal, análise da transcrição).
    await effectsInFlight.get(call.aiSession.id); // a despedida da IA pode ainda estar sendo analisada
    const fresh = await prisma.aiCallSession.findUnique({ where: { id: call.aiSession.id }, select: { outcome: true } }).catch(() => null);
    if (fresh?.outcome) outcome = fresh.outcome;
    await prisma.aiCallSession.update({ where: { id: call.aiSession.id }, data: { outcome } }).catch(() => {});
  }

  if (call.aiCallCampaignId) {
    await recomputeCampaignStats(call.aiCallCampaignId).catch((error) => console.error('Erro ao atualizar contadores da campanha:', error.message));
  }
}

// ------------------------------------------------------------------ tentativas por lead

/** Ligação que realmente falou com alguém (e não caiu em caixa postal). */
function isConnectedCall(call) {
  // Só conta como "atendeu" se houve conversa; atender e ficar mudo ou cair em gravação segue para nova tentativa.
  return (call.aiSession?.turnCount || 0) > 0 && call.aiSession?.outcome !== 'caixa_postal';
}

/** Resume, por lead, o que já aconteceu na campanha: tentativas, última tentativa, se já atendeu e o resultado final. */
async function loadLeadAttempts(campaignId) {
  const calls = await prisma.call.findMany({
    where: { aiCallCampaignId: campaignId },
    orderBy: { createdAt: 'asc' },
    select: { leadId: true, createdAt: true, answeredAt: true, aiSession: { select: { outcome: true, turnCount: true, handoffStatus: true } } }
  });
  const byLead = new Map();
  for (const call of calls) {
    const info = byLead.get(call.leadId) || { attempts: 0, lastAt: null, connected: false, outcome: null, handoff: false };
    info.attempts += 1;
    info.lastAt = call.createdAt;
    if (isConnectedCall(call)) {
      info.connected = true;
      info.outcome = call.aiSession?.outcome || 'sem_conclusao';
      if (call.aiSession?.handoffStatus) info.handoff = true;
    }
    byLead.set(call.leadId, info);
  }
  return byLead;
}

/** Contadores da campanha recalculados do zero a cada ligação (cada lead conta uma vez, mesmo com 3 tentativas). */
async function recomputeCampaignStats(campaignId) {
  const byLead = await loadLeadAttempts(campaignId);
  const stats = { calledCount: byLead.size, answeredCount: 0, hotCount: 0, warmCount: 0, callbackCount: 0, handoffCount: 0, notInterestedCount: 0, noAnswerCount: 0 };
  for (const info of byLead.values()) {
    if (!info.connected) {
      stats.noAnswerCount += 1;
      continue;
    }
    stats.answeredCount += 1;
    if (info.outcome === 'quente') stats.hotCount += 1;
    else if (info.outcome === 'morno') stats.warmCount += 1;
    else if (info.outcome === 'retorno_agendado') stats.callbackCount += 1;
    else if (['nao_interessado', 'optout', 'frio', 'numero_errado'].includes(info.outcome)) stats.notInterestedCount += 1;
    if (info.handoff) stats.handoffCount += 1;
  }
  await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: stats });
}

/**
 * Monta a próxima rodada: quem nunca foi chamado + quem não atendeu e ainda tem tentativas
 * (já passou o intervalo entre tentativas). `nextAt` = quando o próximo "aguardando" libera.
 */
function planRound({ audience, byLead, maxAttempts, retryGapMs, blocked, now = Date.now() }) {
  const queue = [];
  let nextAt = null;
  for (const lead of audience) {
    if (blocked.has(lead.id)) continue;
    const info = byLead.get(lead.id);
    if (!info) {
      queue.push({ ...lead, attempt: 1 });
      continue;
    }
    if (info.connected) continue; // já atendeu: segue o fluxo normal, sem nova ligação
    if (info.attempts >= maxAttempts) continue; // esgotou as tentativas
    const readyAt = info.lastAt.getTime() + retryGapMs;
    if (readyAt <= now) queue.push({ ...lead, attempt: info.attempts + 1 });
    else if (nextAt === null || readyAt < nextAt) nextAt = readyAt;
  }
  // Primeiras tentativas antes das repetições.
  queue.sort((a, b) => a.attempt - b.attempt);
  return { queue, nextAt };
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
      provider: provider.providerName || 'twilio',
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
    // Twilio recebe a abertura junto com o pedido da ligação (como sempre). As outras operadoras
    // consultam o endereço "answer" quando o cliente atende (ver handleAnswerCall).
    const dialect = provider.dialect || 'twiml';
    const dialectParam = dialect === 'twiml' ? '' : `&dialect=${dialect}`;
    const { providerCallId } = await provider.startCall({
      to: lead.phone,
      from: callerNumber.phoneNumber,
      statusCallbackUrl: `${baseUrl()}/api/ai-calls/webhook/status?callId=${callId}${dialectParam}`,
      ...(dialect === 'twiml'
        ? { twiml: await speechify(buildGatherTwiml({ agent, text: opening, callId, protect: true })) }
        : { answerUrl: `${baseUrl()}/api/ai-calls/webhook/answer?callId=${callId}${dialectParam}` }),
      ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
      timeLimitSeconds: agent.maxCallSeconds || 420,
      recordingStatusCallbackUrl: agent.recordCalls ? `${baseUrl()}/api/ai-calls/webhook/recording?callId=${callId}${dialectParam}` : undefined
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
  const provider = await getAiTelephonyProvider(agent.userId);

  const TEST_TAG = 'teste-agente-ia';
  // Um contato de teste POR NÚMERO: testar com outro celular abre outra conversa no Chat
  // (antes o mesmo contato era reaproveitado e só o número mudava).
  let lead = await prisma.lead.findFirst({ where: { userId: agent.userId, tags: { has: TEST_TAG }, phone: e164 } });
  if (lead) {
    lead = await prisma.lead.update({ where: { id: lead.id }, data: { optOut: false } });
  } else {
    lead = await prisma.lead.create({
      data: {
        userId: agent.userId,
        name: `Teste IA — ${e164}`,
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

    const provider = await getAiTelephonyProvider(campaign.userId);
    const maxAttempts = Math.max(1, Math.min(Number(campaign.maxAttempts) || 3, 10));
    const retryGapMs = Math.max(5, Number(campaign.retryGapMinutes) || 180) * 60 * 1000;
    const fmtTime = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: SP_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    let fatalError = null;
    let stopped = false; // pausada/excluída pelo usuário
    const failedToPlace = new Set(); // leads cuja ligação nem chegou a ser criada (evita laço infinito)

    // Espera até `target`, em fatias curtas, mantendo o sinal de vida. Devolve false se a campanha deixou de estar "discando".
    const waitUntil = async (target, note) => {
      while (Date.now() < target.getTime()) {
        const fresh = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
        if (!fresh || fresh.status !== 'discando') return false;
        await heartbeat(campaignId, note);
        await sleep(Math.min(30000, Math.max(1000, target.getTime() - Date.now())));
      }
      return true;
    };

    while (!fatalError && !stopped) {
      const status = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (!status || status.status !== 'discando') {
        stopped = true;
        break;
      }

      // Lista atualizada a cada rodada (quem recusou/pediu para sair já não entra).
      const audience = await resolveAudience(campaign.userId, campaign.audienceFilter, 'sms', {
        select: { id: true, name: true, phone: true }
      });
      await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { totalLeads: audience.length } });
      const blockedRows = audience.length
        ? await prisma.lead.findMany({
            where: { id: { in: audience.map((l) => l.id) }, OR: [{ status: 'perdido' }, { optOut: true }, { tags: { has: 'numero_errado' } }] },
            select: { id: true }
          })
        : [];
      const byLead = await loadLeadAttempts(campaignId);
      const plan = planRound({ audience, byLead, maxAttempts, retryGapMs, blocked: new Set([...blockedRows.map((l) => l.id), ...failedToPlace]) });

      if (plan.queue.length === 0) {
        if (plan.nextAt === null) break; // nada mais a fazer: concluída
        const ok = await waitUntil(new Date(plan.nextAt), `Aguardando para tentar novamente quem não atendeu (próxima tentativa às ${fmtTime(plan.nextAt)})`);
        if (!ok) stopped = true;
        continue;
      }

      if (!isWithinCallWindow(campaign)) {
        const open = nextWindowStart(campaign);
        const ok = await waitUntil(open, `Fora do horário permitido (${campaign.windowStart}–${campaign.windowEnd}${campaign.weekdaysOnly ? ', seg a sex' : ''}). Retoma sozinha em ${fmtTime(open)}`);
        if (!ok) stopped = true;
        continue;
      }

      const queue = plan.queue;
      let outsideWindow = false;

      const worker = async () => {
        while (queue.length > 0 && !fatalError && !outsideWindow) {
          const fresh = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
          if (!fresh || fresh.status !== 'discando') {
            stopped = true;
            return;
          }

          if (!isWithinCallWindow(campaign)) {
            outsideWindow = true;
            return;
          }

          const lead = queue.shift();
          const current = await prisma.lead.findUnique({ where: { id: lead.id }, select: { optOut: true, status: true } });
          if (!current || current.optOut || current.status === 'perdido') continue;

          try {
            await heartbeat(campaignId, `Ligando para ${lead.name}${lead.attempt > 1 ? ` (tentativa ${lead.attempt} de ${maxAttempts})` : ''}…`);
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
            else failedToPlace.add(lead.id);
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
    }

    const finalState = await prisma.aiCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (fatalError) {
      await prisma.aiCallCampaign.update({ where: { id: campaignId }, data: { status: 'pausado', runningNote: `Pausada: ${fatalError.message}` } });
    } else if (!stopped && finalState?.status === 'discando') {
      await prisma.aiCallCampaign.update({
        where: { id: campaignId },
        data: { status: 'concluido', runningNote: `Concluída: todos atenderam, recusaram ou esgotaram as ${maxAttempts} tentativas.` }
      });
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
  nextWindowStart,
  planRound,
  resolveFinalOutcome,
  isConnectedCall,
  markLeadLost,
  recomputeCampaignStats,
  toE164,
  buildOpeningText,
  buildGatherTwiml,
  buildHangupTwiml,
  buildDialTwiml,
  buildHints,
  processTurn,
  handleAnswerCall,
  handleDialResult,
  finalizeAiCall,
  applyOutcomeEffects,
  startTestCall,
  refreshAgentCatalog,
  executeAiCampaign
};
