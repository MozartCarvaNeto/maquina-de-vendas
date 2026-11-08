// backend/src/services/pbx/pbxLive.js
// Painel ao vivo: chamadas em andamento e filas (lido do Asterisk) + supervisão (escutar, sussurrar, entrar na chamada).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const core = require('./pbxCore');
const env = require('../../config/env');

function asterisk(cmd) {
  return new Promise((resolve) => {
    execFile('asterisk', ['-rx', cmd], { timeout: 8000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` }));
  });
}

/** "core show channels concise": Canal!Contexto!Ramal!Prioridade!Estado!App!Dados!CallerID!Conta!Peer!AMA!Duração!Ligado-a */
function parseChannels(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split('!');
    if (f.length < 12 || !/^[A-Za-z]+\//.test(f[0])) continue;
    out.push({ channel: f[0], context: f[1], exten: f[2], state: f[4], app: f[5], data: f[6], callerId: f[7], seconds: parseInt(f[11], 10) || 0, bridgedTo: f[12] || '' });
  }
  return out;
}

/** Só as chamadas desta conta: pelo código da conta no contexto ou pelos ramais/troncos dela. */
function belongsTo(ch, { tag, endpoints }) {
  const ctx = ch.context || '';
  if (ctx.endsWith(`-${tag}`) || ctx.includes(`-${tag}-`)) return true;
  const ep = ch.channel.replace(/^[A-Za-z]+\//, '').replace(/-[0-9a-f]{6,}$/i, '');
  return endpoints.has(ep);
}

/** "queue show": linhas "nome has N calls ..." / membros / quem espera. */
function parseQueues(text, wanted) {
  const queues = [];
  let cur = null;
  let section = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const head = /^(\S+)\s+has\s+(\d+)\s+calls?/.exec(line);
    if (head) {
      cur = { name: head[1], waiting: Number(head[2]), members: [], callers: [] };
      if (wanted.has(cur.name)) queues.push(cur);
      section = '';
      continue;
    }
    if (!cur) continue;
    if (/^\s*Members:/.test(line)) { section = 'm'; continue; }
    if (/^\s*Callers:/.test(line)) { section = 'c'; continue; }
    if (/^\s*No (Members|Callers)/.test(line)) { section = ''; continue; }
    if (section === 'm') {
      const m = /^\s+(\S+).*\((Not in use|In use|Busy|Unavailable|Ringing|Invalid|Unknown|On Hold|Ring\+Inuse)\)/.exec(line);
      if (m) cur.members.push({ member: m[1], status: m[2], paused: /\(paused\)/.test(line) });
    } else if (section === 'c') {
      const m = /^\s+\d+\.\s+(\S+)\s+\(wait:\s*([0-9:]+)/.exec(line);
      if (m) cur.callers.push({ channel: m[1], wait: m[2] });
    }
  }
  return queues;
}

async function liveForUser(prisma, userId) {
  const tag = core.tagFor(userId);
  const [exts, qs] = await Promise.all([prisma.sipExtension.findMany({ where: { userId } }), prisma.pbxQueue.findMany({ where: { userId } })]);
  const endpoints = new Set(exts.map((e) => e.extension));
  const [ch, qr] = await Promise.all([asterisk('core show channels concise'), asterisk('queue show')]);
  if (!ch.ok && /not found|ENOENT|connect/i.test(ch.out)) return { available: false, error: 'Não consegui falar com o Asterisk (ele precisa estar no mesmo servidor).', calls: [], queues: [] };
  const all = parseChannels(ch.out);
  const mine = new Set(all.filter((c) => belongsTo(c, { tag, endpoints })).map((c) => c.channel));
  // a outra ponta da chamada (tronco do operador) também é desta conta
  const channels = all.filter((c) => mine.has(c.channel) || (c.bridgedTo && mine.has(c.bridgedTo)));
  const wanted = new Set(qs.map((q) => core.queueName(tag, q)));
  const nameByQ = new Map(qs.map((q) => [core.queueName(tag, q), q.name]));
  const queues = parseQueues(qr.out, wanted).map((q) => ({ ...q, label: nameByQ.get(q.name) || q.name }));
  const extName = new Map(exts.map((e) => [e.extension, e.name || e.extension]));
  const calls = channels.map((c) => {
    const ep = c.channel.replace(/^[A-Za-z]+\//, '').replace(/-[0-9a-f]{6,}$/i, '');
    return { ...c, who: extName.get(ep) || null, spyable: c.state === 'Up' && /^PJSIP\/[A-Za-z0-9_.@-]+$/.test(c.channel) };
  });
  return { available: true, calls, queues, at: new Date().toISOString() };
}

const MODES = { listen: 'q', whisper: 'qw', barge: 'qB' };

/** Pede ao Asterisk que ligue para o ramal do supervisor e o coloque escutando a chamada. */
function spyCallFile({ supervisorExt, target, mode, tag }) {
  const opts = MODES[mode];
  if (!opts) throw Object.assign(new Error('Modo inválido.'), { status: 400 });
  if (!/^PJSIP\/[A-Za-z0-9_.@-]+$/.test(target)) throw Object.assign(new Error('Canal inválido.'), { status: 400 });
  const lines = [
    `Channel: PJSIP/${supervisorExt}`,
    `CallerID: "Supervisão" <${supervisorExt}>`,
    'WaitTime: 30',
    'MaxRetries: 0',
    'Application: ChanSpy',
    `Data: ${target},${opts}`,
    'Archive: no',
    `Setvar: TP_TAG=${tag}`
  ];
  const name = `turbo-spy-${crypto.randomUUID()}.call`;
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o644 });
  const dest = path.join(env.asteriskSpoolDir, name);
  try {
    try { fs.renameSync(tmp, dest); } catch (_) { fs.copyFileSync(tmp, dest); fs.rmSync(tmp, { force: true }); }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw Object.assign(new Error('Não consegui entregar o pedido ao Asterisk (ele precisa estar no mesmo servidor).'), { status: 502 });
  }
  return { file: name, data: `${target},${opts}` };
}

async function hangupChannel(channel) {
  if (!/^PJSIP\/[A-Za-z0-9_.@-]+$/.test(channel)) throw Object.assign(new Error('Canal inválido.'), { status: 400 });
  return asterisk(`channel request hangup ${channel}`);
}

module.exports = { parseChannels, parseQueues, belongsTo, liveForUser, spyCallFile, hangupChannel, MODES, _asterisk: asterisk };
