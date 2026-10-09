// backend/src/services/broadcastService.js
const path = require('path');
const fs = require('fs');
const prisma = require('../config/db');
const { getEmailProvider } = require('./email/emailProviderFactory');
const { getSmsProvider } = require('./sms/smsProviderFactory');
const { pickNextCallerNumber } = require('./dialerQueueService');
const { buildListLeadWhere } = require('./leadListService');
const whatsappDispatcher = require('./whatsapp/whatsappDispatcher');
const { getSendGate, recordMessageSent } = require('./planService');

const ATTACHMENTS_ROOT = path.join(__dirname, '../../uploads/broadcast-attachments');

// Se o processo morrer, depois deste período o scheduler considera o disparo
// órfão e tenta retomá-lo. Durante pausas longas o heartbeat continua sendo
// renovado, portanto o watchdog não cria uma segunda execução em paralelo.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// Espera por reconexão: 12 tentativas x 15s = até 3 minutos por lead antes de
// pausar. A reconexão automática do WhatsApp leva de ~10s a ~2min.
const MAX_CONSECUTIVE_CONNECTION_ERRORS = 12;
const CONNECTION_RETRY_WAIT_MS = 15 * 1000;

function renderTemplate(template, lead) {
  return (template || '')
    .replace(/{{\s*nome\s*}}/gi, lead.name || '')
    .replace(/{{\s*telefone\s*}}/gi, lead.phone || '')
    .replace(/{{\s*email\s*}}/gi, lead.email || '')
    .replace(/{{\s*endereco\s*}}/gi, lead.address || '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAntiSpamDelay(minSeconds, maxSeconds) {
  const min = Math.max(5, Number(minSeconds) || 40);
  const max = Math.max(min, Number(maxSeconds) || 100);
  return delay(randomInt(min, max) * 1000);
}

function randomBatchPause(minMinutes, maxMinutes) {
  const min = Math.max(1, Number(minMinutes) || 6);
  const max = Math.max(min, Number(maxMinutes) || 18);
  const minutes = randomInt(min, max);
  return { ms: minutes * 60 * 1000, minutes };
}

function isConnectionError(error) {
  if (!error) return false;
  if (error.isConnectionError) return true;
  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('não está ativa') ||
    msg.includes('não está pronta') ||
    msg.includes('não está conectado') ||
    msg.includes('sessão whatsapp indisponível') ||
    msg.includes('session closed') ||
    msg.includes('protocol error') ||
    msg.includes('target closed') ||
    msg.includes('disconnected') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('navigation')
  );
}

// Só as colunas que o disparo realmente usa (nome/telefone/e-mail/endereço para
// as variáveis da mensagem). Evita baixar o lead inteiro a cada consulta.
const AUDIENCE_SELECT = { id: true, name: true, phone: true, email: true, address: true };

/**
 * Condição (where de Lead) que define o público de um disparo. Serve tanto para
 * listar quanto para CONTAR/paginar direto no banco, sem trazer os leads.
 */
async function buildAudienceWhere(userId, audienceFilter, channel) {
  let base;

  if (audienceFilter?.listId) {
    const list = await prisma.leadList.findFirst({
      where: { id: audienceFilter.listId, userId },
      select: { id: true, type: true, filterRules: true }
    });
    if (!list) {
      const err = new Error('Lista de leads informada não foi encontrada');
      err.status = 404;
      throw err;
    }
    base = buildListLeadWhere(userId, list);
  } else {
    base = { userId, optOut: false };
    if (audienceFilter?.status) base.status = audienceFilter.status;
    if (audienceFilter?.campaignId) base.campaignId = audienceFilter.campaignId;
  }

  const extra = [];
  if (channel === 'email') extra.push({ email: { not: null } }, { NOT: { email: '' } });
  if (channel === 'sms' || channel === 'whatsapp') extra.push({ phone: { not: null } }, { NOT: { phone: '' } });

  return extra.length ? { AND: [base, ...extra] } : base;
}

/**
 * `opts.select` troca as colunas retornadas (padrão: todas, para manter o
 * comportamento dos outros módulos, como o robô de ligações).
 */
async function resolveAudience(userId, audienceFilter, channel, opts = {}) {
  const where = await buildAudienceWhere(userId, audienceFilter, channel);
  const leads = await prisma.lead.findMany({
    where,
    ...(opts.select ? { select: opts.select } : {})
  });

  // Ordem determinística: uma retomada percorre exatamente o mesmo público.
  return leads.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// Cache curto do tamanho do público: o total quase não muda em segundos e a
// tela de acompanhamento consulta o progresso com frequência.
const AUDIENCE_COUNT_TTL_MS = 60 * 1000;
const audienceCountCache = new Map();

async function countAudienceWhere(where, cacheKey = null) {
  if (cacheKey) {
    const hit = audienceCountCache.get(cacheKey);
    if (hit && Date.now() - hit.at < AUDIENCE_COUNT_TTL_MS) return hit.total;
  }
  const total = await prisma.lead.count({ where });
  if (cacheKey) {
    if (audienceCountCache.size > 200) audienceCountCache.clear();
    audienceCountCache.set(cacheKey, { total, at: Date.now() });
  }
  return total;
}

async function countAudience(userId, audienceFilter, channel) {
  const where = await buildAudienceWhere(userId, audienceFilter, channel);
  return countAudienceWhere(where);
}

// Leads do público que ainda não foram processados (nem enviado, nem falha).
function pendingLeadWhere(audienceWhere, broadcastId) {
  return {
    AND: [
      audienceWhere,
      { broadcastRecipients: { none: { broadcastCampaignId: broadcastId, status: { in: ['enviado', 'falhou'] } } } }
    ]
  };
}

async function getBroadcastProgress(broadcastId, userId) {
  const broadcast = await prisma.broadcastCampaign.findFirst({
    where: { id: broadcastId, ...(userId ? { userId } : {}) },
    select: {
      id: true,
      userId: true,
      channel: true,
      audienceFilter: true,
      status: true,
      isRunning: true,
      runningNote: true,
      lastHeartbeatAt: true,
      lastRunAt: true
    }
  });
  if (!broadcast) return null;

  const audienceWhere = await buildAudienceWhere(broadcast.userId, broadcast.audienceFilter, broadcast.channel);

  const [grouped, audienceTotal, lastSent, nextPending] = await Promise.all([
    prisma.broadcastRecipient.groupBy({
      by: ['status'],
      where: { broadcastCampaignId: broadcastId },
      _count: { _all: true }
    }),
    countAudienceWhere(audienceWhere, broadcastId),
    prisma.broadcastRecipient.findFirst({
      where: { broadcastCampaignId: broadcastId, status: 'enviado' },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true, lead: { select: { name: true, phone: true } } }
    }),
    broadcast.status === 'concluido'
      ? null
      : prisma.lead.findFirst({
          where: pendingLeadWhere(audienceWhere, broadcastId),
          orderBy: { id: 'asc' },
          select: { name: true, phone: true, email: true }
        })
  ]);

  const countOf = (status) => grouped.find((g) => g.status === status)?._count._all || 0;
  const sent = countOf('enviado');
  const failed = countOf('falhou');
  const pending = Math.max(0, audienceTotal - sent - failed);

  return {
    broadcastId,
    status: broadcast.status,
    isRunning: broadcast.isRunning,
    runningNote: broadcast.runningNote,
    audienceTotal,
    sent,
    failed,
    pending,
    percentComplete: audienceTotal > 0 ? Math.round(((sent + failed) / audienceTotal) * 100) : 0,
    lastHeartbeatAt: broadcast.lastHeartbeatAt,
    lastRunAt: broadcast.lastRunAt,
    // "Onde parou": último contato que recebeu e o próximo da fila. Ao retomar,
    // o disparo continua exatamente deste próximo contato.
    lastContact: lastSent
      ? { name: lastSent.lead?.name || null, phone: lastSent.lead?.phone || null, sentAt: lastSent.sentAt }
      : null,
    nextContact: nextPending
      ? { name: nextPending.name || null, phone: nextPending.phone || null, email: nextPending.email || null }
      : null
  };
}

async function heartbeat(broadcastId, note = null) {
  await prisma.broadcastCampaign
    .update({
      where: { id: broadcastId },
      data: {
        lastHeartbeatAt: new Date(),
        ...(note !== null ? { runningNote: note } : {})
      }
    })
    .catch(() => null);
}

/**
 * Aguarda sem deixar o heartbeat envelhecer. Isso é essencial porque os
 * disparos podem ficar 6–18 minutos em uma pausa de lote.
 */
async function waitWithHeartbeat(broadcastId, ms, note) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const remaining = end - Date.now();
    const chunk = Math.min(HEARTBEAT_INTERVAL_MS, remaining);
    await delay(chunk);
    if (Date.now() < end) await heartbeat(broadcastId, note);
  }
}

async function refreshWhatsappConnections(userId) {
  const rows = await prisma.whatsappConnection.findMany({
    where: { userId, status: 'conectado' },
    orderBy: { createdAt: 'asc' }
  });

  // Só usa conexões realmente prontas — sessão nativa viva na memória do
  // servidor, ou conexão Cloud API com token cadastrado. Antes, uma conexão
  // marcada como "conectado" no banco mas já morta era escolhida no rodízio
  // e derrubava o disparo mesmo havendo outra conexão saudável.
  return rows.filter((conn) => whatsappDispatcher.isReady(conn));
}

/**
 * Após reiniciar o servidor as sessões demoram a ficar prontas. Em vez de
 * pausar o disparo na hora, aguarda (renovando o heartbeat) até `maxMs`.
 */
async function waitForReadyConnections(broadcastId, userId, maxMs = 3 * 60 * 1000) {
  const end = Date.now() + maxMs;
  let connections = await refreshWhatsappConnections(userId);
  while (connections.length === 0 && Date.now() < end) {
    await waitWithHeartbeat(broadcastId, CONNECTION_RETRY_WAIT_MS, 'Aguardando o WhatsApp conectar…');
    connections = await refreshWhatsappConnections(userId);
  }
  return connections;
}

async function markPausedForConnection(broadcastId, note) {
  await prisma.broadcastCampaign.update({
    where: { id: broadcastId },
    data: {
      status: 'pausado',
      isRunning: false,
      lastHeartbeatAt: new Date(),
      runningNote: note
    }
  });
}

async function executeBroadcast(broadcastId) {
  // Lock distribuído no PostgreSQL. O lock só pode ser tomado se não houver
  // outra execução viva. O heartbeat é renovado inclusive durante pausas.
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const lockClaim = await prisma.broadcastCampaign.updateMany({
    where: {
      id: broadcastId,
      OR: [
        { isRunning: false },
        { isRunning: true, lastHeartbeatAt: { lt: staleBefore } },
        { isRunning: true, lastHeartbeatAt: null }
      ]
    },
    data: {
      isRunning: true,
      status: 'enviando',
      lastHeartbeatAt: new Date(),
      runningNote: 'Iniciando...'
    }
  });

  if (lockClaim.count === 0) {
    console.log(`⏭️ Disparo ${broadcastId} já está em execução — ignorando chamada duplicada.`);
    return;
  }

  const broadcast = await prisma.broadcastCampaign.findUnique({
    where: { id: broadcastId },
    include: { variants: { orderBy: { position: 'asc' } } }
  });

  if (!broadcast) return;

  const attachments = Array.isArray(broadcast.attachments) ? broadcast.attachments : [];
  const firstAttachment = attachments[0] || null;
  const whatsappMediaPath =
    broadcast.channel === 'whatsapp' && firstAttachment
      ? path.join(ATTACHMENTS_ROOT, broadcastId, firstAttachment.filename)
      : null;

  if (broadcast.channel === 'whatsapp' && whatsappMediaPath && !fs.existsSync(whatsappMediaPath)) {
    await prisma.broadcastCampaign.update({
      where: { id: broadcast.id },
      data: { status: 'falhou', isRunning: false, runningNote: 'A imagem anexada não foi encontrada no servidor.' }
    });
    return;
  }

  const emailAttachments = attachments.map((a) => ({
    filename: a.originalName || a.filename,
    path: path.join(ATTACHMENTS_ROOT, broadcastId, a.filename)
  }));

  let sentCount = 0;
  let failedCount = 0;
  let interrupted = false;

  try {
    const leads = await resolveAudience(broadcast.userId, broadcast.audienceFilter, broadcast.channel, { select: AUDIENCE_SELECT });

    if (broadcast.channel === 'whatsapp' && broadcast.variants.length === 0) {
      await prisma.broadcastCampaign.update({
        where: { id: broadcast.id },
        data: { status: 'falhou', isRunning: false, runningNote: 'Nenhuma variação de mensagem cadastrada.' }
      });
      return;
    }

    let whatsappConnections = broadcast.channel === 'whatsapp'
      ? await waitForReadyConnections(broadcast.id, broadcast.userId)
      : [];

    if (broadcast.channel === 'whatsapp' && whatsappConnections.length === 0) {
      await markPausedForConnection(
        broadcast.id,
        'Nenhuma conexão WhatsApp está conectada. Conecte o WhatsApp e clique em Retomar.'
      );
      return;
    }

    let variantCursor = broadcast.lastVariantIndex || 0;
    let connectionCursor = broadcast.lastConnectionIndex || 0;
    let sentSinceBatchPause = broadcast.sentSinceBatchPause || 0;
    let consecutiveConnectionErrors = 0;

    // Retomada sem repetir: carrega UMA vez quem já foi processado (enviado ou
    // falha) e pula esses contatos em memória. Antes eram 2 consultas por lead
    // do público inteiro a cada retomada. A ordem do público é fixa (por id),
    // então o disparo continua do próximo contato ainda não processado.
    // Em campanhas recorrentes cada rodada recomeça do início, como antes.
    const doneLeadIds = new Set();
    if (broadcast.scheduleType !== 'recurring') {
      const done = await prisma.broadcastRecipient.findMany({
        where: { broadcastCampaignId: broadcast.id, status: { in: ['enviado', 'falhou'] } },
        select: { leadId: true }
      });
      done.forEach((r) => doneLeadIds.add(r.leadId));
    }

    for (let leadIndex = 0; leadIndex < leads.length; leadIndex += 1) {
      const lead = leads[leadIndex];
      if (doneLeadIds.has(lead.id)) continue;

      const current = await prisma.broadcastCampaign.findUnique({
        where: { id: broadcast.id },
        select: { status: true, isRunning: true }
      });

      if (!current || current.status === 'pausado' || current.isRunning === false) {
        interrupted = true;
        break;
      }

      // Conta vencida/bloqueada ou cota mensal do plano esgotada: pausa o disparo.
      const sendGate = await getSendGate(broadcast.userId);
      if (!sendGate.ok) {
        await prisma.broadcastCampaign.update({
          where: { id: broadcast.id },
          data: { status: 'pausado', runningNote: sendGate.note }
        });
        interrupted = true;
        break;
      }

      // Em caso de conexão perdida, tentamos algumas vezes o MESMO lead antes
      // de pausá-lo. Assim o próximo ciclo não avança silenciosamente pelo
      // público sem enviar aquele contato.
      let sentThisLead = false;
      let connectionAttemptsForLead = 0;

      while (!sentThisLead) {
        try {
          if (broadcast.channel === 'whatsapp') {
            whatsappConnections = await refreshWhatsappConnections(broadcast.userId);
            if (whatsappConnections.length === 0) {
              throw Object.assign(
                new Error('Nenhuma conexão WhatsApp conectada no momento.'),
                { isConnectionError: true }
              );
            }

            const variant = broadcast.variants[variantCursor % broadcast.variants.length];
            const safeConnectionIndex = connectionCursor % whatsappConnections.length;
            const connection = whatsappConnections[safeConnectionIndex];
            const renderedBody = renderTemplate(variant.body, lead);

            await heartbeat(
              broadcast.id,
              `Enviando para ${lead.name || lead.phone} (contato ${leadIndex + 1} de ${leads.length})…`
            );

            const sendableConnection =
              connection.provider === 'cloud_api'
                ? await whatsappDispatcher.loadConnectionForSending(connection.id)
                : connection;

            await whatsappDispatcher.sendMessage(sendableConnection, lead.phone, renderedBody, whatsappMediaPath);

            await prisma.message.create({
              data: {
                leadId: lead.id,
                direction: 'saida',
                channel: 'whatsapp',
                body: renderedBody
              }
            });

            variantCursor += 1;
            connectionCursor += 1;
            sentSinceBatchPause += 1;
            consecutiveConnectionErrors = 0;

            await prisma.broadcastCampaign.update({
              where: { id: broadcast.id },
              data: {
                lastVariantIndex: variantCursor % broadcast.variants.length,
                lastConnectionIndex: connectionCursor % whatsappConnections.length,
                sentSinceBatchPause,
                lastHeartbeatAt: new Date(),
                runningNote: `Último envio: ${lead.name || lead.phone}`
              }
            });

            await prisma.broadcastRecipient.upsert({
              where: {
                broadcastCampaignId_leadId: {
                  broadcastCampaignId: broadcast.id,
                  leadId: lead.id
                }
              },
              update: { status: 'enviado', sentAt: new Date(), errorMessage: null },
              create: {
                broadcastCampaignId: broadcast.id,
                leadId: lead.id,
                status: 'enviado',
                sentAt: new Date()
              }
            });

            sentCount += 1;
            recordMessageSent(broadcast.userId);
            sentThisLead = true;

            if (sentSinceBatchPause >= (broadcast.batchSize || 15)) {
              const { ms, minutes } = randomBatchPause(
                broadcast.batchPauseMinMinutes,
                broadcast.batchPauseMaxMinutes
              );
              const resumeAt = new Date(Date.now() + ms);
              const note = `Pausa de ${minutes} min — retoma às ${resumeAt.toLocaleTimeString('pt-BR')}`;
              console.log(`⏸️ Disparo "${broadcast.name}": ${note}`);
              await heartbeat(broadcast.id, note);
              await waitWithHeartbeat(broadcast.id, ms, note);
              sentSinceBatchPause = 0;
              await prisma.broadcastCampaign.update({
                where: { id: broadcast.id },
                data: { sentSinceBatchPause: 0, lastHeartbeatAt: new Date(), runningNote: 'Retomando envios…' }
              });
            } else {
              const seconds = randomInt(
                Math.max(5, Number(broadcast.minDelaySeconds) || 40),
                Math.max(Math.max(5, Number(broadcast.minDelaySeconds) || 40), Number(broadcast.maxDelaySeconds) || 100)
              );
              const note = `Aguardando ${seconds}s antes do próximo envio…`;
              await heartbeat(broadcast.id, note);
              await waitWithHeartbeat(broadcast.id, seconds * 1000, note);
            }
          } else if (broadcast.channel === 'email') {
            if (!lead.email) throw new Error('Lead sem e-mail cadastrado');
            const emailProvider = await getEmailProvider(broadcast.userId, { emailDomainId: broadcast.emailDomainId });
            await emailProvider.sendEmail({
              to: lead.email,
              subject: renderTemplate(broadcast.subject || '', lead),
              html: renderTemplate(broadcast.message, lead),
              attachments: emailAttachments,
              // Usados só pelo provedor "native", para casar cada envio com
              // a estatística de abertura/clique e com o disparo de origem.
              // Provedores antigos (Resend/SMTP) simplesmente ignoram.
              leadId: lead.id,
              broadcastCampaignId: broadcast.id
            });

            await prisma.broadcastRecipient.upsert({
              where: {
                broadcastCampaignId_leadId: {
                  broadcastCampaignId: broadcast.id,
                  leadId: lead.id
                }
              },
              update: { status: 'enviado', sentAt: new Date(), errorMessage: null },
              create: {
                broadcastCampaignId: broadcast.id,
                leadId: lead.id,
                status: 'enviado',
                sentAt: new Date()
              }
            });
            sentCount += 1;
            recordMessageSent(broadcast.userId);
            sentThisLead = true;
            await heartbeat(broadcast.id, `Enviando… (${sentCount} enviados nesta rodada)`);
          } else if (broadcast.channel === 'sms') {
            if (!lead.phone) throw new Error('Lead sem telefone cadastrado');
            const smsProvider = await getSmsProvider(broadcast.userId);
            const callerNumber = await pickNextCallerNumber(broadcast.userId);
            if (!callerNumber) {
              throw new Error('Nenhum número cadastrado em Linhas > Números de Discagem para enviar SMS');
            }
            await smsProvider.sendSms({
              to: lead.phone,
              from: callerNumber.phoneNumber,
              body: renderTemplate(broadcast.message, lead)
            });

            await prisma.broadcastRecipient.upsert({
              where: {
                broadcastCampaignId_leadId: {
                  broadcastCampaignId: broadcast.id,
                  leadId: lead.id
                }
              },
              update: { status: 'enviado', sentAt: new Date(), errorMessage: null },
              create: {
                broadcastCampaignId: broadcast.id,
                leadId: lead.id,
                status: 'enviado',
                sentAt: new Date()
              }
            });
            sentCount += 1;
            recordMessageSent(broadcast.userId);
            sentThisLead = true;
            await heartbeat(broadcast.id, `Enviando… (${sentCount} enviados nesta rodada)`);
          } else {
            throw new Error(`Canal "${broadcast.channel}" não suportado`);
          }
        } catch (error) {
          if (broadcast.channel === 'whatsapp' && isConnectionError(error)) {
            connectionAttemptsForLead += 1;
            consecutiveConnectionErrors += 1;
            await heartbeat(
              broadcast.id,
              `WhatsApp indisponível — aguardando reconexão (${connectionAttemptsForLead}/${MAX_CONSECUTIVE_CONNECTION_ERRORS})…`
            );

            // Se a conexão caiu, não marcamos o lead como falha e não avançamos
            // o cursor. Tentamos o mesmo contato novamente após alguns segundos.
            if (connectionAttemptsForLead < MAX_CONSECUTIVE_CONNECTION_ERRORS) {
              await waitWithHeartbeat(broadcast.id, CONNECTION_RETRY_WAIT_MS, 'Aguardando reconexão do WhatsApp…');
              continue;
            }

            interrupted = true;
            await markPausedForConnection(
              broadcast.id,
              'Conexão do WhatsApp caiu durante o disparo. Reconecte o número e clique em Retomar. Os leads já enviados serão mantidos.'
            );
            break;
          }

          await prisma.broadcastRecipient.upsert({
            where: {
              broadcastCampaignId_leadId: {
                broadcastCampaignId: broadcast.id,
                leadId: lead.id
              }
            },
            update: { status: 'falhou', errorMessage: error.message },
            create: {
              broadcastCampaignId: broadcast.id,
              leadId: lead.id,
              status: 'falhou',
              errorMessage: error.message
            }
          });
          failedCount += 1;
          sentThisLead = true;
          await heartbeat(broadcast.id, `Falha em ${lead.name || lead.phone}: ${error.message}`);
        }
      }

      if (interrupted) break;
    }
  } catch (error) {
    interrupted = true;
    console.error(`❌ Erro geral no disparo ${broadcast.id}:`, error.message);
    await prisma.broadcastCampaign.update({
      where: { id: broadcast.id },
      data: { status: 'pausado', runningNote: `Interrompido: ${error.message}` }
    }).catch(() => null);
  } finally {
    const current = await prisma.broadcastCampaign.findUnique({
      where: { id: broadcast.id },
      select: { status: true }
    }).catch(() => null);

    // Se outro caminho já marcou como pausado/falhou, respeitamos esse estado.
    const finalStatus = current?.status === 'pausado'
      ? 'pausado'
      : current?.status === 'falhou'
        ? 'falhou'
        : interrupted
          ? 'pausado'
          : broadcast.scheduleType === 'recurring'
            ? 'agendado'
            : 'concluido';

    await prisma.broadcastCampaign.update({
      where: { id: broadcast.id },
      data: {
        status: finalStatus,
        isRunning: false,
        lastRunAt: new Date(),
        lastHeartbeatAt: new Date(),
        runningNote: finalStatus === 'concluido' || finalStatus === 'agendado' ? null : undefined
      }
    }).catch(() => null);

    console.log(
      `📣 Disparo "${broadcast.name}" (${broadcast.channel}) ${finalStatus}: ${sentCount} enviados, ${failedCount} falharam nesta rodada`
    );
  }
}

module.exports = {
  executeBroadcast,
  renderTemplate,
  resolveAudience,
  buildAudienceWhere,
  pendingLeadWhere,
  countAudience,
  getBroadcastProgress,
  isConnectionError,
  HEARTBEAT_STALE_MS
};