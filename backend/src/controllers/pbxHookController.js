// backend/src/controllers/pbxHookController.js
// Avisos que o Asterisk (no mesmo servidor) manda ao sistema: fim de chamada (histórico + gravação) e ponte da IA.
const env = require('../config/env');
const prisma = require('../config/db');
const core = require('../services/pbx/pbxCore');
const svc = require('../services/pbx/pbxService');
const bridge = require('../services/pbx/aiBridge');
const wallet = require('../services/walletService');

function guard(req, res) {
  if (!core.safeEqual(req.query.t, core.hookToken())) {
    res.status(403).type('text/plain').send('NO');
    return false;
  }
  return true;
}

const clip = (v, n = 64) => String(v || '').slice(0, n);
const num = (v) => Math.max(0, parseInt(v, 10) || 0);

exports.event = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const q = req.query;
    const tag = clip(q.tag, 8);
    if (q.ai === '1') return res.type('text/plain').send('IGNORED'); // ligação da IA é registrada no aiEnd
    const userId = await svc.userIdByTag(tag);
    if (!userId || !q.uid) return res.type('text/plain').send('IGNORED');
    const dir = q.dir === 'out' ? 'saida' : 'entrada';
    const bill = num(q.bill);
    const dur = num(q.dur);
    const answered = q.ds === 'ANSWER' || ['COMPLETEAGENT', 'COMPLETECALLER'].includes(q.qs);
    const rec = /^[a-z0-9]{4}-[0-9.]+$/.test(q.rec || '') && q.rec.startsWith(`${tag}-`) ? q.rec : null;
    const vm = /^[a-z0-9]{4}-vm-[0-9.]+$/.test(q.vm || '') && q.vm.startsWith(`${tag}-`) ? q.vm : null;
    let status;
    if (answered) status = 'atendida';
    else if (vm) status = 'recado';
    else status = dir === 'saida' ? 'nao_atendida' : 'perdida';
    const now = new Date();
    const ext = clip(q.ext, 32) || null;
    let memberId = null;
    if (ext) {
      const e = await prisma.sipExtension.findFirst({ where: { userId, extension: ext } });
      memberId = e?.memberId || null;
    }
    const data = {
      direction: dir,
      fromNumber: clip(q.from, 40) || null,
      toNumber: clip(q.to, 40) || null,
      trunk: clip(q.trunk) || null,
      routeId: clip(q.route, 40) || null,
      queueName: clip(q.queue) || null,
      extension: ext,
      memberId,
      status,
      startedAt: new Date(now.getTime() - dur * 1000),
      answeredAt: answered && bill > 0 ? new Date(now.getTime() - bill * 1000) : null,
      endedAt: now,
      durationSeconds: answered ? bill : 0,
      recordingFile: rec,
      voicemailFile: vm,
      hangupCause: clip(q.cause, 16) || null
    };
    // Saldo pré-pago: cobra a chamada atendida uma única vez (a chamada já aconteceu, então o saldo pode ficar negativo).
    const before = await prisma.pbxCall.findUnique({ where: { userId_uniqueId: { userId, uniqueId: clip(q.uid, 40) } } });
    if (answered && bill > 0 && !(before && before.costBrl > 0)) {
      data.costBrl = await wallet.chargeCall(userId, { direction: dir, seconds: bill, refId: clip(q.uid, 40), description: `Ligação ${dir === 'saida' ? 'para' : 'de'} ${clip(dir === 'saida' ? q.to : q.from, 20) || '—'} (${bill}s)` }).catch((e) => { console.error('Cobrança da chamada:', e.message); return 0; });
    }
    await prisma.pbxCall.upsert({
      where: { userId_uniqueId: { userId, uniqueId: clip(q.uid, 40) } },
      update: data,
      create: { userId, uniqueId: clip(q.uid, 40), ...data }
    });
    const io = global.socketIoInstance;
    if (io) io.to(`user:${userId}`).emit('pbx:call', { status });
    res.type('text/plain').send('OK');
  } catch (e) {
    console.error('PBX evento:', e.message);
    res.type('text/plain').send('ERR');
  }
};

/** O Asterisk pergunta antes de discar: tem saldo? Resposta: NO | YES | YES:<segundos máximos>. Se este aviso falhar, a ligação segue (não derruba a telefonia). */
exports.allow = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const userId = await svc.userIdByTag(clip(req.query.tag, 8));
    if (!userId) return res.type('text/plain').send('YES');
    const a = await wallet.voiceAllowance(userId);
    res.type('text/plain').send(!a.allowed ? 'NO' : a.maxSeconds == null ? 'YES' : `YES:${Math.min(a.maxSeconds, 14400)}`);
  } catch (e) {
    res.type('text/plain').send('YES');
  }
};

/** Ligação RECEBIDA atendida pela IA: cria lead/ligação/sessão e devolve o id para o AudioSocket. */
exports.aiStart = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const userId = await svc.userIdByTag(clip(req.query.tag, 8));
    if (!userId) return res.type('text/plain').send('NO');
    const out = await bridge.startInbound(userId, { from: clip(req.query.from, 32), to: clip(req.query.to, 32), uniqueId: clip(req.query.uid, 40) });
    res.type('text/plain').send(out || 'NO');
  } catch (e) {
    console.error('PBX IA recebida:', e.message);
    res.type('text/plain').send('NO');
  }
};

/**
 * Discador pelo Asterisk: traduz os avisos do plano de discagem para os mesmos eventos que a Twilio mandava
 * (assim o discador, a fila automática e o repasse ao vendedor funcionam sem mudar).
 */
exports.dialEvent = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const q = req.query;
    const sid = clip(q.sid, 40);
    if (!/^ast-[0-9a-f]{32}$/.test(sid)) return res.type('text/plain').send('IGNORED');
    let status;
    if (q.ev === 'answered') status = 'in-progress';
    else {
      const ds = String(q.ds || '');
      status = ds === 'ANSWER' ? 'completed' : ds === 'BUSY' ? 'busy' : ['NOANSWER', 'CANCEL', ''].includes(ds) ? 'no-answer' : 'failed';
    }
    const fake = { set() { return this; }, status() { return this; }, send() { return this; }, json() { return this; }, type() { return this; } };
    const cid = /^[0-9a-f-]{36}$/i.test(q.cid || '') ? String(q.cid) : null;
    if (cid) {
      // URA reversa (robô): mesmos avisos de status que a Twilio mandava
      await require('./roboCallWebhookController').handleStatus({ query: { callId: cid }, body: { CallSid: sid, CallStatus: status } }, fake);
    } else {
      await require('./callsWebhookController').handleTwilioWebhook({ body: { CallSid: sid, CallStatus: status, Source: 'asterisk' } }, fake, (e) => { if (e) console.error('Discador Asterisk:', e.message); });
    }
    if (cid && q.ev === 'end') {
      const f = `robo-${cid}.wav`;
      if (await require('../services/pbx/asteriskHost').exists(`${require('../services/pbx/asteriskHost').dirs().rec}/${f}`)) {
        await prisma.call.update({ where: { id: cid }, data: { recordingUrl: `local:${f}` } }).catch(() => null);
      }
    }
    // cobrança da perna do cliente (a do vendedor é interna)
    if (q.ev === 'end' && status === 'completed' && q.leg === 'lead') {
      const secs = num(q.at);
      const call = await prisma.call.findFirst({ where: cid ? { id: cid } : { providerCallId: sid } });
      if (call && secs > 0) {
        await wallet.chargeCall(call.userId, { direction: 'saida', seconds: secs, refId: sid, description: `Ligação do discador (${secs}s)` }).catch(() => 0);
      }
    }
    res.type('text/plain').send('OK');
  } catch (e) {
    console.error('PBX discador:', e.message);
    res.type('text/plain').send('ERR');
  }
};

/** Robô: guarda a tecla apertada durante a abertura (a ponte decide o rumo). */
exports.roboDigit = (req, res) => {
  if (!guard(req, res)) return;
  bridge.setDigit(String(req.query.callId || ''), String(req.query.d || '').replace(/[^0-9*#]/g, '').slice(0, 1));
  res.type('text/plain').send('OK');
};

exports.aiNext = (req, res) => {
  if (!guard(req, res)) return;
  res.type('text/plain').send(bridge.nextAction(String(req.query.callId || '')));
};

exports.aiEnd = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const callId = String(req.query.callId || '');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call) return res.type('text/plain').send('IGNORED');
    const answered = req.query.ds === 'ANSWER' || ['COMPLETEAGENT', 'COMPLETECALLER'].includes(req.query.qs);
    await bridge.endCall(callId, { dialStatus: answered ? 'ANSWER' : clip(req.query.ds, 16) });
    // a gravação da ligação da IA entra no histórico do PBX
    const fresh = await prisma.call.findUnique({ where: { id: callId } });
    const uniqueId = `ai-${callId}`.slice(0, 40);
    const existing = await prisma.pbxCall.findUnique({ where: { userId_uniqueId: { userId: call.userId, uniqueId } } });
    let costBrl = existing?.costBrl || 0;
    if (!existing && fresh?.answeredAt && fresh.durationSeconds > 0) {
      costBrl = await wallet.chargeCall(call.userId, { direction: fresh.direction === 'entrada' ? 'entrada' : 'saida', seconds: fresh.durationSeconds, refId: uniqueId, description: `Ligação da IA (${fresh.durationSeconds}s)` }).catch(() => 0);
    }
    await prisma.pbxCall.upsert({
      where: { userId_uniqueId: { userId: call.userId, uniqueId } },
      update: {},
      create: {
        userId: call.userId,
        uniqueId,
        costBrl,
        direction: 'ia',
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        status: fresh?.answeredAt ? 'atendida' : 'nao_atendida',
        startedAt: call.startedAt || new Date(),
        answeredAt: fresh?.answeredAt || null,
        endedAt: new Date(),
        durationSeconds: fresh?.durationSeconds || 0,
        recordingFile: `ai-${callId}`,
        aiCallId: callId
      }
    });
    res.type('text/plain').send('OK');
  } catch (e) {
    console.error('PBX fim da IA:', e.message);
    res.type('text/plain').send('ERR');
  }
};
