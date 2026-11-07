// backend/src/controllers/pbxHookController.js
// Avisos que o Asterisk (no mesmo servidor) manda ao sistema: fim de chamada (histórico + gravação) e ponte da IA.
const prisma = require('../config/db');
const core = require('../services/pbx/pbxCore');
const svc = require('../services/pbx/pbxService');
const bridge = require('../services/pbx/aiBridge');

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
    await prisma.pbxCall.upsert({
      where: { userId_uniqueId: { userId: call.userId, uniqueId: `ai-${callId}`.slice(0, 40) } },
      update: {},
      create: {
        userId: call.userId,
        uniqueId: `ai-${callId}`.slice(0, 40),
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
