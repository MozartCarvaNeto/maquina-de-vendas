// backend/src/services/smsgw/gateway.js
//
// Gateway de SMS nativo: mantém as ligações SMPP com os fornecedores, enfileira os SMS,
// escolhe o fornecedor (prioridade + menor custo, trocando se um falhar), registra relatórios
// de entrega (DLR) e respostas dos clientes (MO, incluindo "SAIR"), e calcula o consumo.
const { EventEmitter } = require('events');
const prisma = require('../../config/db');
const { encrypt, decrypt } = require('../crypto/settingsCrypto');
const { SmppSession } = require('./smpp');
const { encodeSms, countSegments } = require('./gsm');
const { toE164BR } = require('../../utils/phone');
const wallet = require('../walletService');
const smsWebhook = require('./smsWebhook');

const sessions = new Map(); // carrierId -> { session, carrier }
const events = new EventEmitter();
events.setMaxListeners(0);
let workerTimer = null;
let working = false;
const priceCache = new Map(); // userId -> { value, at }

const MAX_ATTEMPTS = 5;
const OPT_OUT_WORDS = new Set(['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'DESCADASTRAR', 'REMOVER', 'NAO QUERO', 'NÃO QUERO']);

// ---------------------------------------------------------------------------------------------------------------
// Fornecedores (sessões SMPP)
// ---------------------------------------------------------------------------------------------------------------
function carrierPassword(carrier) {
  return decrypt(carrier.passwordEnc);
}

function sessionConfig(carrier) {
  return {
    host: carrier.host,
    port: carrier.port,
    tls: carrier.useTls,
    systemId: carrier.systemId,
    password: carrierPassword(carrier),
    systemType: carrier.systemType || '',
    tps: carrier.tps,
    windowSize: carrier.windowSize
  };
}

async function recordCarrierState(carrierId, state, error) {
  try {
    await prisma.smsCarrier.update({
      where: { id: carrierId },
      data: {
        lastStatus: state,
        lastError: error ? String(error).slice(0, 300) : null,
        ...(state === 'bound' ? { lastBoundAt: new Date() } : {})
      }
    });
  } catch (_) {
    /* fornecedor removido */
  }
}

function stopCarrier(carrierId) {
  const entry = sessions.get(carrierId);
  if (entry) {
    entry.session.removeAllListeners();
    entry.session.stop();
    sessions.delete(carrierId);
  }
}

function startCarrier(carrier) {
  stopCarrier(carrier.id);
  if (!carrier.enabled) return;
  let session;
  try {
    session = new SmppSession(sessionConfig(carrier));
  } catch (e) {
    recordCarrierState(carrier.id, 'erro', `Senha ilegível: ${e.message}. Cadastre o fornecedor de novo.`);
    return;
  }
  session.on('state', (state, err) => recordCarrierState(carrier.id, state === 'bound' ? 'bound' : state, err));
  session.on('dlr', (d) => handleDlr(d, 0));
  session.on('mo', (m) => handleMo(carrier, m).catch((e) => console.error('SMS MO:', e.message)));
  sessions.set(carrier.id, { session, carrier });
  session.start();
}

async function syncCarrier(carrierId) {
  const carrier = await prisma.smsCarrier.findUnique({ where: { id: carrierId } });
  if (!carrier) return stopCarrier(carrierId);
  startCarrier(carrier);
}

function carrierRuntime(carrierId) {
  const entry = sessions.get(carrierId);
  return entry ? { state: entry.session.state, error: entry.session.lastError } : { state: 'parado', error: null };
}

/** Escolhe os fornecedores possíveis para um destino, em ordem: menor prioridade, depois menor custo. */
function candidateCarriers(userId, toE164) {
  const digits = String(toE164 || '').replace(/\D/g, '');
  const usable = (c) => c.enabled && sessions.get(c.id).session.state === 'bound';
  const all = [...sessions.values()].map((e) => e.carrier);
  // fornecedores do próprio cliente (se houver); senão, os da plataforma (venda por saldo)
  const own = all.filter((c) => c.userId === userId && usable(c));
  const platformIds = require('../platformService').platformAccountIdsSync();
  const pool = own.length ? own : all.filter((c) => platformIds.includes(c.userId) && usable(c));
  return pool
    .filter((c) => {
      const prefixes = String(c.allowedPrefixes || '').split(',').map((p) => p.trim()).filter(Boolean);
      return !prefixes.length || prefixes.some((p) => digits.startsWith(p.replace(/\D/g, '')));
    })
    .sort((a, b) => a.priority - b.priority || a.costPerPart - b.costPerPart);
}

// ---------------------------------------------------------------------------------------------------------------
// Preço cobrado do cliente final (Configurações do gateway)
// ---------------------------------------------------------------------------------------------------------------
async function getGatewaySettings(userId) {
  const rows = await prisma.setting.findMany({ where: { userId, category: 'smsgw', isActive: true } });
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = decrypt(r.value);
    } catch (_) { /* ignora */ }
  }
  return { priceBrl: Number(out.priceBrl) || 0, useInBroadcasts: out.useInBroadcasts === 'true' };
}

async function getPrice(userId) {
  const cached = priceCache.get(userId);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const { priceBrl } = await getGatewaySettings(userId);
  priceCache.set(userId, { value: priceBrl, at: Date.now() });
  return priceBrl;
}

async function saveGatewaySettings(userId, { priceBrl, useInBroadcasts }) {
  const entries = {};
  if (priceBrl !== undefined) entries.priceBrl = String(Math.max(0, Number(priceBrl) || 0));
  if (useInBroadcasts !== undefined) entries.useInBroadcasts = useInBroadcasts ? 'true' : 'false';
  for (const [key, value] of Object.entries(entries)) {
    await prisma.setting.upsert({
      where: { userId_category_provider_key: { userId, category: 'smsgw', provider: 'native', key } },
      update: { value: encrypt(value), isActive: true },
      create: { userId, category: 'smsgw', provider: 'native', key, value: encrypt(value) }
    });
  }
  priceCache.delete(userId);
}

// ---------------------------------------------------------------------------------------------------------------
// Fila e envio
// ---------------------------------------------------------------------------------------------------------------
/**
 * Coloca um SMS na fila. Retorna o registro (status "queued").
 * @param {{userId, to, body, from?, source?, apiKeyId?, clientRef?}} p
 */
async function enqueue(p) {
  const to = toE164BR(p.to);
  if (!to) {
    const e = new Error(`Telefone inválido: "${p.to}"`);
    e.status = 400;
    throw e;
  }
  const body = String(p.body || '');
  if (!body.trim()) {
    const e = new Error('Mensagem vazia');
    e.status = 400;
    throw e;
  }
  if (body.length > 1600) {
    const e = new Error('Mensagem longa demais (máximo 1600 caracteres).');
    e.status = 400;
    throw e;
  }
  const { parts, encoding } = countSegments(body);
  const price = await getPrice(p.userId);
  let sendAt = null;
  if (p.sendAt) {
    sendAt = new Date(p.sendAt);
    if (Number.isNaN(sendAt.getTime())) {
      const e = new Error('Data/hora de agendamento inválida.');
      e.status = 400;
      throw e;
    }
    if (sendAt.getTime() > Date.now() + 30 * 24 * 3600 * 1000) {
      const e = new Error('Só dá para agendar até 30 dias à frente.');
      e.status = 400;
      throw e;
    }
    if (sendAt.getTime() <= Date.now() + 5000) sendAt = null;
  }
  let callbackUrl = null;
  if (p.callbackUrl) callbackUrl = await smsWebhook.validateUrl(p.callbackUrl);
  // Cobra antes de enfileirar (sem saldo → erro 402). Se algo falhar depois, estorna.
  const total = price * parts;
  if (await require('../optOutService').isBlocked(p.userId, to, 'sms')) {
    const e = new Error(`O número ${to} está na lista de bloqueio (pediu para não receber mensagens).`);
    e.status = 422;
    e.optedOut = true;
    throw e;
  }
  await require('../telecomLimitService').assertSms(p.userId, parts);
  await wallet.charge(p.userId, total, { type: 'sms', description: `SMS para ${to}${sendAt ? ' (agendado)' : ''}`, quantity: parts });
  await require('../telecomLimitService').recordSms(p.userId, parts);
  try {
    return await prisma.smsMessage.create({
      data: {
        userId: p.userId,
        direction: 'out',
        fromAddr: p.from || '',
        toAddr: to,
        body,
        encoding,
        parts,
        status: 'queued',
        nextAttemptAt: sendAt || new Date(),
        priceBrl: total,
        source: p.source || 'app',
        apiKeyId: p.apiKeyId || null,
        callbackUrl,
        clientRef: p.clientRef ? String(p.clientRef).slice(0, 100) : null
      }
    });
  } catch (e) {
    await wallet.refund(p.userId, total, `Estorno: falha ao enfileirar SMS para ${to}`).catch(() => null);
    throw e;
  }
}

/** Cancela um SMS agendado que ainda não saiu (estorna o valor). */
async function cancelQueued(userId, id) {
  const msg = await prisma.smsMessage.findFirst({ where: { id, userId, direction: 'out' } });
  if (!msg) throw Object.assign(new Error('Mensagem não encontrada.'), { status: 404 });
  const r = await prisma.smsMessage.updateMany({ where: { id, userId, status: 'queued' }, data: { status: 'failed', errorMessage: 'Cancelado pelo usuário', priceBrl: 0 } });
  if (!r.count) throw Object.assign(new Error('Essa mensagem já saiu ou está sendo enviada: não dá mais para cancelar.'), { status: 409 });
  await wallet.refund(userId, msg.priceBrl, 'Estorno: SMS cancelado', msg.id).catch(() => null);
  return { success: true };
}

/** Enfileira e ESPERA o resultado (usado pelos disparos, que precisam saber se deu certo). */
async function sendAndWait(p, timeoutMs = 60000) {
  const msg = await enqueue(p);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      events.removeListener(`done:${msg.id}`, onDone);
      // Cancela o que ainda não saiu, para não ser enviado depois (evita duplicar quando o disparo tentar de novo).
      await prisma.smsMessage
        .updateMany({ where: { id: msg.id, status: 'queued' }, data: { status: 'failed', errorMessage: 'Cancelado: nenhum fornecedor disponível a tempo.', priceBrl: 0 } })
        .then((r) => (r.count ? wallet.refund(msg.userId, msg.priceBrl, 'Estorno: SMS cancelado (sem fornecedor)', msg.id) : null))
        .catch(() => null);
      reject(Object.assign(new Error('O gateway não conseguiu enviar a tempo (fornecedores indisponíveis).'), { configProblem: true }));
    }, timeoutMs);
    function onDone(result) {
      clearTimeout(timer);
      if (result.status === 'sent') resolve(result);
      else reject(Object.assign(new Error(result.errorMessage || 'Falha no envio'), { configProblem: Boolean(result.configProblem) }));
    }
    events.once(`done:${msg.id}`, onDone);
  });
}

async function finishFailed(msg, errorCode, errorMessage, extra = {}) {
  const failed = await prisma.smsMessage.update({
    where: { id: msg.id },
    data: { status: 'failed', errorCode, errorMessage, attempts: (msg.attempts || 0) + 1, priceBrl: 0 }
  });
  await wallet.refund(msg.userId, msg.priceBrl, 'Estorno: SMS não enviado', msg.id).catch(() => null);
  smsWebhook.notify(failed);
  events.emit(`done:${msg.id}`, { status: 'failed', errorMessage, configProblem: extra.configProblem });
}

async function processMessage(msg) {
  const candidates = candidateCarriers(msg.userId, msg.toAddr);
  let lastError = null;
  let permanent = null;

  for (const carrier of candidates) {
    const entry = sessions.get(carrier.id);
    if (!entry) continue;
    const enc = encodeSms(msg.body, { normalize: carrier.normalize });
    const from = msg.fromAddr || carrier.defaultSender || '';
    if (!from) {
      lastError = new Error(`Fornecedor "${carrier.name}" sem remetente: informe o remetente padrão no cadastro.`);
      lastError.configProblem = true;
      continue;
    }
    try {
      const ids = await entry.session.submit({
        from,
        to: msg.toAddr.replace(/^\+/, ''),
        segments: enc.segments,
        dataCoding: enc.dataCoding,
        concat: carrier.concatMode
      });
      const finalPrice = (await getPrice(msg.userId)) * enc.parts;
      if (Math.abs(finalPrice - (msg.priceBrl || 0)) > 0.00001) {
        // O número de partes mudou (ex.: acentos removidos): acerta a diferença no saldo.
        const diff = finalPrice - (msg.priceBrl || 0);
        if (diff > 0) await wallet.charge(msg.userId, diff, { type: 'sms', description: 'Ajuste de partes do SMS', refId: msg.id, force: true }).catch(() => null);
        else await wallet.refund(msg.userId, -diff, 'Ajuste de partes do SMS', msg.id).catch(() => null);
      }
      const sentRow = await prisma.smsMessage.update({
        where: { id: msg.id },
        data: {
          status: 'sent',
          carrierId: carrier.id,
          fromAddr: from,
          providerIds: `,${ids.join(',')},`,
          encoding: enc.encoding,
          parts: enc.parts,
          costBrl: carrier.costPerPart * enc.parts,
          priceBrl: finalPrice,
          attempts: (msg.attempts || 0) + 1,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null
        }
      });
      smsWebhook.notify(sentRow);
      events.emit(`done:${msg.id}`, { status: 'sent', providerIds: ids });
      return;
    } catch (e) {
      lastError = e;
      if (e.smppStatus !== undefined && !e.temporary) {
        // Erro definitivo informado pelo fornecedor (ex.: número inválido): não adianta trocar.
        permanent = e;
        break;
      }
      // temporário (limite excedido, sessão caiu...): tenta o próximo fornecedor.
    }
  }

  if (permanent) {
    return finishFailed(msg, `smpp:${permanent.smppStatus}`, `O fornecedor recusou: ${permanent.message}`);
  }
  const attempts = (msg.attempts || 0) + 1;
  const reason = candidates.length === 0
    ? 'Nenhum fornecedor de SMS conectado para este destino'
    : `Fornecedores indisponíveis (${lastError ? lastError.message : 'erro'})`;
  if (attempts >= MAX_ATTEMPTS || (lastError && lastError.configProblem)) {
    return finishFailed(msg, 'sem_fornecedor', reason, { configProblem: true });
  }
  await prisma.smsMessage.update({
    where: { id: msg.id },
    data: { status: 'queued', attempts, nextAttemptAt: new Date(Date.now() + 10000 * attempts), errorMessage: reason }
  });
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await require('../platformService').platformAccountIds();
    const due = await prisma.smsMessage.findMany({
      where: { direction: 'out', status: 'queued', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 100
    });
    const claimed = [];
    for (const m of due) {
      const r = await prisma.smsMessage.updateMany({ where: { id: m.id, status: 'queued' }, data: { status: 'sending' } });
      if (r.count) claimed.push(m);
    }
    // Um fornecedor já controla seu próprio ritmo (TPS/janela): despachamos em paralelo.
    await Promise.all(claimed.map((m) => processMessage(m).catch(async (e) => {
      console.error('SMS gateway:', e.message);
      await prisma.smsMessage.update({ where: { id: m.id }, data: { status: 'queued', nextAttemptAt: new Date(Date.now() + 15000) } }).catch(() => null);
    })));
  } catch (e) {
    console.error('SMS gateway (fila):', e.message);
  } finally {
    working = false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Relatório de entrega (DLR) e respostas (MO)
// ---------------------------------------------------------------------------------------------------------------
async function handleDlr(d, attempt) {
  if (!d.smscId) return;
  const msg = await prisma.smsMessage.findFirst({ where: { providerIds: { contains: `,${d.smscId},` } } });
  if (!msg) {
    // O relatório pode chegar antes de o envio ser gravado: tenta de novo por alguns segundos.
    if (attempt < 6) setTimeout(() => handleDlr(d, attempt + 1).catch(() => null), 1000);
    return;
  }
  if (d.stat === 'DELIVRD') {
    // Incremento atômico: as partes de um SMS longo podem confirmar ao mesmo tempo.
    const updated = await prisma.smsMessage.update({
      where: { id: msg.id },
      data: { partsDelivered: { increment: 1 } }
    });
    if (updated.partsDelivered >= updated.parts && updated.status !== 'delivered') {
      const done = await prisma.smsMessage.update({ where: { id: msg.id }, data: { status: 'delivered', deliveredAt: new Date() } });
      smsWebhook.notify(done);
    }
  } else if (['UNDELIV', 'REJECTD', 'EXPIRED', 'DELETED', 'UNKNOWN'].includes(d.stat)) {
    if (msg.status !== 'delivered') {
      const und = await prisma.smsMessage.update({
        where: { id: msg.id },
        data: { status: 'undelivered', errorCode: d.err || d.stat, errorMessage: `Não entregue (${d.stat}${d.err ? `, código ${d.err}` : ''})` }
      });
      smsWebhook.notify(und);
    }
  }
}

function phoneVariants(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const out = new Set([digits]);
  if (digits.startsWith('55')) out.add(digits.slice(2));
  return [...out].filter(Boolean);
}

async function handleMo(carrier, mo) {
  const moRow = await prisma.smsMessage.create({
    data: {
      userId: carrier.userId,
      carrierId: carrier.id,
      direction: 'in',
      fromAddr: mo.from,
      toAddr: mo.to,
      body: mo.text,
      status: 'received',
      source: 'mo'
    }
  });
  smsWebhook.notify(moRow);
  const word = mo.text.trim().toUpperCase().replace(/[.!]+$/, '');
  if (OPT_OUT_WORDS.has(word)) {
    const variants = phoneVariants(mo.from);
    const leads = await prisma.lead.findMany({ where: { userId: carrier.userId, phone: { not: null } }, select: { id: true, phone: true } });
    const ids = leads.filter((l) => {
      const v = String(l.phone).replace(/\D/g, '');
      return variants.some((x) => v === x || v.endsWith(x) || x.endsWith(v));
    }).map((l) => l.id);
    if (ids.length) await prisma.lead.updateMany({ where: { id: { in: ids } }, data: { optOut: true } });
    await require('../optOutService').addQuiet(carrier.userId, mo.from, { channel: 'all', source: 'sms_reply', reason: `Respondeu "${word}" por SMS` });
  }
}

// ---------------------------------------------------------------------------------------------------------------
async function start() {
  let carriers;
  try {
    carriers = await prisma.smsCarrier.findMany({ where: { enabled: true } });
  } catch (e) {
    console.warn('📡 Gateway SMS desativado: tabelas ainda não criadas (rode docs/atualizar_banco_gateway_telecom.sql no Supabase). Motivo:', e.message.split('\n').pop());
    return;
  }
  for (const c of carriers) startCarrier(c);
  if (!workerTimer) workerTimer = setInterval(tick, 1000);
  if (carriers.length) console.log(`📡 Gateway SMS: ${carriers.length} fornecedor(es) SMPP iniciando.`);
}

function stopAll() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  for (const id of [...sessions.keys()]) stopCarrier(id);
}

module.exports = {
  start,
  stopAll,
  tick,
  syncCarrier,
  stopCarrier,
  carrierRuntime,
  enqueue,
  sendAndWait,
  cancelQueued,
  getGatewaySettings,
  saveGatewaySettings,
  candidateCarriers,
  handleDlr,
  events,
  _sessions: sessions
};
