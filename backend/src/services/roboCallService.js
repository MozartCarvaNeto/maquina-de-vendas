// backend/src/services/roboCallService.js
//
// Ligações robô (URA reversa): o sistema liga para o lead, toca um áudio
// gravado, escuta se ele demonstrou interesse (apertando uma tecla OU
// falando), e — se houver interesse — avisa que a conversa continua no
// WhatsApp, move o lead no CRM e dispara a mensagem de WhatsApp sozinho.
const crypto = require('crypto');
const prisma = require('../config/db');
const env = require('../config/env');
const { getActiveTelephonyProvider } = require('./telephony/providerFactory');
const { resolveAudience, renderTemplate, HEARTBEAT_STALE_MS } = require('./broadcastService');
const whatsappDispatcher = require('./whatsapp/whatsappDispatcher');

const TERMINAL_STATUSES = ['encerrada', 'ocupado', 'falhou', 'sem_resposta'];
const MAX_CALL_WAIT_MS = 4 * 60 * 1000;
const RING_TIMEOUT_SECONDS = 25;
const CALL_TIME_LIMIT_SECONDS = 180;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// ==================== INTERPRETAÇÃO DA RESPOSTA ====================

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Frases que significam "não me ligue mais" — além de não qualificar, o lead
// é marcado como opt-out para nunca mais receber ligação.
const OPT_OUT_PHRASES = [
  'pare de ligar', 'nao ligue', 'nao me ligue', 'nao liguem', 'parem de ligar',
  'remover meu numero', 'tirar meu numero', 'tire meu numero', 'me tire da lista',
  'nao quero receber', 'nao quero mais receber', 'excluir meu numero'
];

const NEGATIVE_PHRASES = [
  'nao', 'nao quero', 'sem interesse', 'nao tenho interesse', 'nao tenho', 'agora nao',
  'nao obrigado', 'negativo', 'desisto', 'nao preciso', 'nao posso', 'ocupado', 'errou'
];

const POSITIVE_PHRASES = [
  'sim', 'quero', 'tenho interesse', 'interesse', 'interessado', 'interessada', 'pode',
  'claro', 'com certeza', 'gostaria', 'manda', 'mande', 'me chama', 'pode falar',
  'uhum', 'aham', 'positivo', 'topo', 'vamos', 'ok', 'fechado', 'bora'
];

function containsPhrase(normalizedText, phrase) {
  return new RegExp(`(^| )${phrase}( |$)`).test(normalizedText);
}

/**
 * Decide se a resposta do lead é de interesse.
 * Retorna { decision: 'interessado' | 'sem_interesse' | 'sem_resposta' | 'nao_entendido', optOut: boolean }
 * Regra de ouro: negativa vence positiva ("não quero" contém "quero").
 */
function classifyResponse({ digits, speech, confidence }, campaign) {
  const pressed = String(digits || '').trim();
  if (pressed) {
    if (pressed === campaign.digitInterested) return { decision: 'interessado', optOut: false };
    if (pressed === campaign.digitNotInterested) return { decision: 'sem_interesse', optOut: false };
    return { decision: 'nao_entendido', optOut: false };
  }

  const heard = normalizeText(speech);
  if (!heard) return { decision: 'sem_resposta', optOut: false };
  if (campaign.useSpeechRecognition === false) return { decision: 'nao_entendido', optOut: false };

  // Reconhecimento de fala muito incerto vale menos que nada: não qualifica.
  const conf = Number(confidence);
  if (!Number.isNaN(conf) && conf > 0 && conf < 0.3) return { decision: 'nao_entendido', optOut: false };

  if (OPT_OUT_PHRASES.some((phrase) => containsPhrase(heard, phrase))) {
    return { decision: 'sem_interesse', optOut: true };
  }
  if (NEGATIVE_PHRASES.some((phrase) => containsPhrase(heard, phrase))) {
    return { decision: 'sem_interesse', optOut: false };
  }
  if (POSITIVE_PHRASES.some((phrase) => containsPhrase(heard, phrase))) {
    return { decision: 'interessado', optOut: false };
  }
  return { decision: 'nao_entendido', optOut: false };
}

// ==================== TwiML ====================

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function audioUrl(campaignId, filename) {
  return `${env.backendPublicUrl.replace(/\/$/, '')}/uploads/robocall-audio/${campaignId}/${encodeURIComponent(filename)}`;
}

/** TwiML que roda quando o lead atende: toca o áudio e escuta tecla/fala ao mesmo tempo. */
function buildIntroTwiml(campaign, callId) {
  const action = `${env.backendPublicUrl.replace(/\/$/, '')}/api/robocalls/webhook/gather?callId=${callId}`;
  const input = campaign.useSpeechRecognition ? 'dtmf speech' : 'dtmf';
  const hints = 'sim, quero, tenho interesse, pode falar, não, não quero, sem interesse';
  const speechAttrs = campaign.useSpeechRecognition
    ? ` speechTimeout="auto" language="pt-BR" hints="${escapeXml(hints)}"`
    : '';

  return `<Response>
  <Gather input="${input}" numDigits="1" timeout="8"${speechAttrs} actionOnEmptyResult="true" action="${escapeXml(action)}" method="POST">
    <Play>${escapeXml(audioUrl(campaign.id, campaign.introAudioFilename))}</Play>
  </Gather>
  <Say language="pt-BR">Não identificamos sua resposta. Obrigado pela atenção, até logo.</Say>
  <Hangup/>
</Response>`;
}

function buildInterestedTwiml(campaign) {
  const content = campaign.interestedAudioFilename
    ? `<Play>${escapeXml(audioUrl(campaign.id, campaign.interestedAudioFilename))}</Play>`
    : '<Say language="pt-BR">Perfeito! Vamos continuar o seu atendimento pelo WhatsApp, é só aguardar a nossa mensagem. Obrigado!</Say>';
  return `<Response>${content}<Hangup/></Response>`;
}

function buildNotInterestedTwiml(campaign) {
  const content = campaign.notInterestedAudioFilename
    ? `<Play>${escapeXml(audioUrl(campaign.id, campaign.notInterestedAudioFilename))}</Play>`
    : '<Say language="pt-BR">Sem problemas. Obrigado pelo seu tempo, tenha um ótimo dia!</Say>';
  return `<Response>${content}<Hangup/></Response>`;
}

// ==================== LEAD QUALIFICADO: CRM + WHATSAPP ====================

async function resolveCrmColumn(campaign) {
  if (campaign.crmColumnId) {
    const column = await prisma.crmColumn.findFirst({
      where: { id: campaign.crmColumnId, board: { userId: campaign.userId } }
    });
    if (column) return column;
  }
  const qualifiedColumn = await prisma.crmColumn.findFirst({
    where: { name: { equals: 'Qualificado', mode: 'insensitive' }, board: { userId: campaign.userId } }
  });
  if (qualifiedColumn) return qualifiedColumn;
  return prisma.crmColumn.findFirst({
    where: { board: { userId: campaign.userId } },
    orderBy: [{ board: { createdAt: 'asc' } }, { position: 'asc' }]
  });
}

async function addLeadToCrm(campaign, lead) {
  const column = await resolveCrmColumn(campaign);
  if (!column) return { added: false, reason: 'Nenhum quadro de CRM cadastrado' };

  const stamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const note = `📞 Qualificado por ligação robô "${campaign.name}" em ${stamp}.`;
  const existing = await prisma.crmCard.findUnique({ where: { leadId: lead.id } });
  const cardCount = await prisma.crmCard.count({ where: { columnId: column.id } });

  await prisma.crmCard.upsert({
    where: { leadId: lead.id },
    update: {
      columnId: column.id,
      position: cardCount,
      notes: existing?.notes ? `${existing.notes}\n${note}` : note
    },
    create: { leadId: lead.id, columnId: column.id, position: cardCount, notes: note }
  });

  return { added: true, columnName: column.name };
}

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

async function sendWhatsappFollowup(campaign, lead) {
  if (!campaign.whatsappFollowupMessage || !lead.phone) return { sent: false, reason: 'sem mensagem ou telefone' };
  const connection = await pickReadyWhatsappConnection(campaign.userId);
  if (!connection) return { sent: false, reason: 'nenhum WhatsApp conectado' };

  const text = renderTemplate(campaign.whatsappFollowupMessage, lead);
  await whatsappDispatcher.sendMessage(connection, lead.phone, text);
  return { sent: true };
}

/**
 * Tudo que acontece quando um lead demonstra interesse. O CRM é gravado na
 * hora (rápido); o WhatsApp roda em segundo plano porque o envio pode
 * demorar alguns segundos e a Twilio não espera resposta por muito tempo.
 */
async function handleQualifiedLead(campaign, call, lead) {
  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'qualificado' } });
  const crm = await addLeadToCrm(campaign, lead).catch((err) => ({ added: false, reason: err.message }));

  sendWhatsappFollowup(campaign, lead)
    .then((result) => {
      if (!result.sent) console.warn(`⚠️ Follow-up WhatsApp não enviado (${lead.name}): ${result.reason}`);
    })
    .catch((err) => console.error(`❌ Falha no follow-up WhatsApp (${lead.name}):`, err.message));

  const io = global.socketIoInstance;
  if (io) {
    io.to(`user:${campaign.userId}`).emit('robocall:qualified', {
      campaignId: campaign.id,
      leadId: lead.id,
      leadName: lead.name,
      leadPhone: lead.phone,
      crm
    });
  }
}

// ==================== EXECUÇÃO DA CAMPANHA ====================

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

async function waitForCallToFinish(callId) {
  const deadline = Date.now() + MAX_CALL_WAIT_MS;
  while (Date.now() < deadline) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { status: true } });
    if (!call || TERMINAL_STATUSES.includes(call.status)) return true;
    await sleep(2000);
  }
  return false;
}

async function heartbeat(campaignId, note) {
  await prisma.roboCallCampaign.update({
    where: { id: campaignId },
    data: { lastHeartbeatAt: new Date(), runningNote: note || null }
  });
}

async function placeRoboCall(campaign, lead, provider) {
  const callerNumber = campaign.callerNumberId
    ? await prisma.callerNumber.findFirst({ where: { id: campaign.callerNumberId, isActive: true } })
    : await prisma.callerNumber.findFirst({
        where: { userId: campaign.userId, isActive: true },
        orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } }
      });
  if (!callerNumber) {
    const err = new Error('Nenhum número de discagem ativo. Cadastre em Linhas > Números de Discagem.');
    err.status = 400;
    err.fatal = true;
    throw err;
  }

  const callId = crypto.randomUUID();
  const base = env.backendPublicUrl.replace(/\/$/, '');

  await prisma.call.create({
    data: {
      id: callId,
      userId: campaign.userId,
      leadId: lead.id,
      provider: 'twilio',
      fromNumber: callerNumber.phoneNumber,
      toNumber: lead.phone,
      callerNumberId: callerNumber.id,
      roboCallCampaignId: campaign.id,
      answeredBy: 'robo',
      status: 'iniciando',
      startedAt: new Date()
    }
  });

  try {
    const { providerCallId } = await provider.startCall({
      to: lead.phone,
      from: callerNumber.phoneNumber,
      statusCallbackUrl: `${base}/api/robocalls/webhook/status?callId=${callId}`,
      twiml: buildIntroTwiml(campaign, callId),
      ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
      timeLimitSeconds: CALL_TIME_LIMIT_SECONDS,
      recordingStatusCallbackUrl: campaign.recordCallsEnabled
        ? `${base}/api/robocalls/webhook/recording?callId=${callId}`
        : undefined
    });

    await prisma.call.update({ where: { id: callId }, data: { providerCallId } });
    await prisma.callerNumber.update({ where: { id: callerNumber.id }, data: { lastUsedAt: new Date() } });
    return callId;
  } catch (error) {
    await prisma.call.update({ where: { id: callId }, data: { status: 'falhou', endedAt: new Date() } });
    await prisma.roboCallCampaign.update({
      where: { id: campaign.id },
      data: { calledCount: { increment: 1 }, noAnswerCount: { increment: 1 } }
    });
    throw error;
  }
}

async function executeRoboCampaign(campaignId) {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const claim = await prisma.roboCallCampaign.updateMany({
    where: {
      id: campaignId,
      OR: [
        { isRunning: false },
        { isRunning: true, lastHeartbeatAt: { lt: staleBefore } },
        { isRunning: true, lastHeartbeatAt: null }
      ]
    },
    data: { isRunning: true, status: 'discando', lastHeartbeatAt: new Date(), runningNote: 'Iniciando…' }
  });
  if (claim.count === 0) return;

  try {
    const campaign = await prisma.roboCallCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return;

    const provider = await getActiveTelephonyProvider(campaign.userId);
    const audience = await resolveAudience(campaign.userId, campaign.audienceFilter, 'sms');

    const alreadyCalled = await prisma.call.findMany({
      where: { roboCallCampaignId: campaignId },
      select: { leadId: true }
    });
    const calledIds = new Set(alreadyCalled.map((c) => c.leadId));
    const queue = audience.filter((lead) => !calledIds.has(lead.id));

    await prisma.roboCallCampaign.update({ where: { id: campaignId }, data: { totalLeads: audience.length } });

    let fatalError = null;

    const worker = async () => {
      while (queue.length > 0 && !fatalError) {
        const fresh = await prisma.roboCallCampaign.findUnique({
          where: { id: campaignId },
          select: { status: true }
        });
        if (!fresh || fresh.status !== 'discando') return;

        const lead = queue.shift();
        const current = await prisma.lead.findUnique({ where: { id: lead.id }, select: { optOut: true } });
        if (!current || current.optOut) continue;

        try {
          await heartbeat(campaignId, `Ligando para ${lead.name}…`);
          const callId = await placeRoboCall(campaign, lead, provider);
          const finished = await waitForCallToFinish(callId);
          if (!finished) {
            const stuck = await prisma.call.findUnique({ where: { id: callId } });
            if (stuck?.providerCallId) await provider.hangupCall({ providerCallId: stuck.providerCallId }).catch(() => {});
          }
        } catch (error) {
          console.error(`❌ Ligação robô para ${lead.name}: ${error.message}`);
          if (error.fatal || error.twilioCode === 20003) fatalError = error;
        }

        if (queue.length > 0 && !fatalError) {
          const wait = randomBetween(campaign.minDelaySeconds, campaign.maxDelaySeconds);
          await heartbeat(campaignId, `Próxima ligação em ${wait}s`);
          await sleep(wait * 1000);
        }
      }
    };

    const workers = Math.max(1, Math.min(campaign.concurrency || 1, 5));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    const finalState = await prisma.roboCallCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (fatalError) {
      await prisma.roboCallCampaign.update({
        where: { id: campaignId },
        data: { status: 'pausado', runningNote: `Pausada: ${fatalError.message}` }
      });
    } else if (finalState?.status === 'discando') {
      await prisma.roboCallCampaign.update({
        where: { id: campaignId },
        data: { status: 'concluido', runningNote: 'Todas as ligações foram concluídas.' }
      });
    }
  } catch (error) {
    console.error(`❌ Campanha robô ${campaignId} falhou:`, error.message);
    await prisma.roboCallCampaign
      .update({ where: { id: campaignId }, data: { status: 'pausado', runningNote: `Pausada: ${error.message}` } })
      .catch(() => {});
  } finally {
    await prisma.roboCallCampaign
      .update({ where: { id: campaignId }, data: { isRunning: false } })
      .catch(() => {});
  }
}

module.exports = {
  TERMINAL_STATUSES,
  normalizeText,
  classifyResponse,
  buildIntroTwiml,
  buildInterestedTwiml,
  buildNotInterestedTwiml,
  handleQualifiedLead,
  validatePublicUrl,
  executeRoboCampaign
};