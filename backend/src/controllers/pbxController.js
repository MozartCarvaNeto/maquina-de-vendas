// backend/src/controllers/pbxController.js
// Telefonia PBX nativa: áudios, URA, filas, rotas de entrada, histórico/gravações, configuração do Asterisk.
const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../config/db');
const core = require('../services/pbx/pbxCore');
const svc = require('../services/pbx/pbxService');
const { normalizeToAsteriskWav, wavToSlin8k, int16ToBuffer, buildWav } = require('../services/pbx/wav');
const { ensureAllExtensions } = require('../services/smsgw/sipExtensions');
const fail = (res, status, error) => res.status(status).json({ error });
const str = (v, n = 80) => String(v ?? '').trim().slice(0, n);
const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d));

// ------------------------------------------------------------------ visão geral
/** Cliente do plano com telefonia e sem número: entrega um do estoque (se o administrador ligou a atribuição automática). */
async function autoAssignDids(userId, req) {
  try {
    if (req.isPlatformAdmin) return;
    const got = await require('../services/pbx/didService').autoAssign(userId);
    if (got.length) applyQuietly([userId, ...(await require('../services/platformService').platformAccountIds())]);
  } catch (e) {
    console.warn('Atribuição automática de número falhou:', e.message);
  }
}

/** Grava os arquivos do Asterisk das contas citadas (sem derrubar nada se o Asterisk não estiver neste servidor). */
function applyQuietly(accountIds) {
  [...new Set(accountIds)].forEach((id) => svc.applyConfig(id).catch((e) => console.warn(`Aplicar Asterisk (${id}):`, e.message)));
}

exports.overview = async (req, res, next) => {
  try {
    const userId = req.userId;
    await autoAssignDids(userId, req);
    const [audios, ivrs, queues, routes, trunksAll, settings, exts] = await Promise.all([
      prisma.pbxAudio.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      prisma.pbxIvr.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.pbxQueue.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.pbxInboundRoute.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.sipTrunk.findMany({ where: { userId }, select: { id: true, name: true, enabled: true } }),
      core.getPbxSettings(userId),
      ensureAllExtensions(userId)
    ]);
    res.json({
      tag: core.tagFor(userId),
      dids: await (async () => { const dd = require('../services/pbx/didService'); const s = await dd.autoSettings(); return (await dd.forAccount(userId)).map((d) => ({ id: d.id, number: d.number, label: d.label, suspended: Boolean(d.suspendedAt), overdue: Boolean(d.overdueSince), monthlyFeeBrl: s.billing ? (d.monthlyFeeBrl ?? s.feeBrl) : 0, nextBillAt: s.billing ? d.nextBillAt : null })); })(),
      isPlatformAdmin: Boolean(req.isPlatformAdmin),
      audios,
      ivrs,
      queues,
      routes,
      trunks: req.isPlatformAdmin ? trunksAll : [],
      settings,
      members: exts.map((e) => ({ memberId: e.memberId, name: e.name, extension: e.extension }))
    });
  } catch (e) {
    next(e);
  }
};

exports.saveSettings = async (req, res, next) => {
  try {
    const b = req.body || {};
    const clean = {
      recordInbound: b.recordInbound === false || b.recordInbound === 'false' ? 'false' : 'true',
      recordOutbound: b.recordOutbound === false || b.recordOutbound === 'false' ? 'false' : 'true',
      aiHandoffQueueId: str(b.aiHandoffQueueId, 60),
      aiInboundAgentId: str(b.aiInboundAgentId, 60),
      aiInboundGreeting: str(b.aiInboundGreeting, 400),
      sttLanguage: str(b.sttLanguage, 10) || 'pt-BR',
      sttProvider: ['auto', 'gemini', 'google', 'azure', 'openai'].includes(b.sttProvider) ? b.sttProvider : 'auto'
    };
    if (clean.aiHandoffQueueId) {
      const q = await prisma.pbxQueue.findFirst({ where: { id: clean.aiHandoffQueueId, userId: req.userId } });
      if (!q) return fail(res, 400, 'Fila inválida.');
    }
    if (clean.aiInboundAgentId) {
      const ag = await prisma.aiVoiceAgent.findFirst({ where: { id: clean.aiInboundAgentId, userId: req.userId } });
      if (!ag) return fail(res, 400, 'Agente de IA inválido.');
    }
    res.json(await core.savePbxSettings(req.userId, clean));
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ áudios
exports.uploadAudio = async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'Envie um arquivo de áudio.');
    const kind = req.body.kind === 'moh' ? 'moh' : 'prompt';
    const { wav, durationMs } = await normalizeToAsteriskWav(req.file.buffer, req.file.originalname);
    if (durationMs < 200) return fail(res, 400, 'Áudio muito curto.');
    const id = crypto.randomUUID();
    await svc.saveAudioFile(req.userId, id, wav, kind);
    const name = str(req.body.name, 80) || str(req.file.originalname.replace(/\.[^.]+$/, ''), 80) || 'Áudio';
    const row = await prisma.pbxAudio.create({ data: { id, userId: req.userId, name, kind, durationMs } });
    res.status(201).json(row);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    if (/WAV|ffmpeg|converter/i.test(e.message)) return fail(res, 400, e.message);
    next(e);
  }
};

/** Cria o áudio a partir de um texto, com a voz da IA (Gemini). */
exports.ttsAudio = async (req, res, next) => {
  try {
    const text = str(req.body.text, 1200);
    if (!text) return fail(res, 400, 'Escreva o texto da locução.');
    let pcm;
    try {
      pcm = await require('../services/pbx/voiceEngines').synthesize(req.userId, str(req.body.voice, 120) || 'gemini:Kore', text, { fallback: false });
    } catch (e) {
      return fail(res, e.status === 400 ? 400 : 502, e.message);
    }
    const wav = buildWav(pcm, 8000);
    const id = crypto.randomUUID();
    await svc.saveAudioFile(req.userId, id, wav, 'prompt');
    const row = await prisma.pbxAudio.create({
      data: { id, userId: req.userId, name: str(req.body.name, 80) || text.slice(0, 40), kind: 'prompt', durationMs: Math.round((pcm.length / 2 / 8000) * 1000) }
    });
    res.status(201).json(row);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

exports.audioFile = async (req, res, next) => {
  try {
    const a = await prisma.pbxAudio.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!a) return fail(res, 404, 'Áudio não encontrado.');
    const p = svc.audioFilePath(req.userId, a.id);
    const ah = require('../services/pbx/asteriskHost');
    if (!(await ah.exists(p))) return fail(res, 404, 'Arquivo do áudio não está no servidor.');
    res.type('audio/wav');
    ah.readStream(p).pipe(res);
  } catch (e) {
    next(e);
  }
};

exports.deleteAudio = async (req, res, next) => {
  try {
    const id = req.params.id;
    const used =
      (await prisma.pbxIvr.findMany({ where: { userId: req.userId } })).some((i) => i.greetingAudioId === id || i.invalidAudioId === id) ||
      (await prisma.pbxQueue.findMany({ where: { userId: req.userId } })).some((q) => q.mohAudioId === id);
    if (used) return fail(res, 409, 'Esse áudio está em uso por uma URA ou fila. Troque antes de apagar.');
    const r = await prisma.pbxAudio.deleteMany({ where: { id, userId: req.userId } });
    if (!r.count) return fail(res, 404, 'Áudio não encontrado.');
    await svc.removeAudioFile(req.userId, id);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ URA / filas / rotas
async function destOk(userId, d) {
  const c = core.cleanDest(d);
  if (!c) return null;
  if (c.type === 'queue' && !(await prisma.pbxQueue.findFirst({ where: { id: c.id, userId } }))) return undefined;
  if (c.type === 'ivr' && !(await prisma.pbxIvr.findFirst({ where: { id: c.id, userId } }))) return undefined;
  if (c.type === 'extension' && !c.id && !c.value) return undefined;
  if (c.type === 'number' && String(c.value || '').replace(/\D/g, '').length < 8) return undefined;
  return c;
}

async function ownedAudio(userId, id) {
  if (!id) return null;
  const a = await prisma.pbxAudio.findFirst({ where: { id: String(id), userId } });
  return a ? a.id : undefined;
}

exports.saveIvr = async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = req.userId;
    const name = str(b.name);
    if (!name) return fail(res, 400, 'Dê um nome para a URA.');
    const greeting = await ownedAudio(userId, b.greetingAudioId);
    const invalid = await ownedAudio(userId, b.invalidAudioId);
    if (greeting === undefined || invalid === undefined) return fail(res, 400, 'Áudio inválido.');
    const options = [];
    const seen = new Set();
    for (const o of Array.isArray(b.options) ? b.options : []) {
      const digit = str(o.digit, 1);
      if (!/^[0-9*#]$/.test(digit) || seen.has(digit)) return fail(res, 400, `Tecla inválida ou repetida: "${digit}".`);
      seen.add(digit);
      const dest = await destOk(userId, o.dest);
      if (!dest) return fail(res, 400, `Configure o destino da tecla ${digit}.`);
      if (dest.type === 'ivr' && dest.id === req.params.id) return fail(res, 400, 'Uma URA não pode apontar para ela mesma.');
      options.push({ digit, dest });
    }
    let timeoutDest = null;
    if (b.timeoutDest && b.timeoutDest.type) {
      timeoutDest = await destOk(userId, b.timeoutDest);
      if (!timeoutDest) return fail(res, 400, 'Destino de "sem resposta" inválido.');
    }
    const data = {
      name,
      greetingAudioId: greeting,
      invalidAudioId: invalid,
      timeoutSeconds: num(b.timeoutSeconds, 6, 2, 30),
      maxRetries: num(b.maxRetries, 2, 1, 5),
      options,
      timeoutDest,
      extensionDial: !!b.extensionDial,
      enabled: b.enabled !== false
    };
    const row = req.params.id
      ? await prisma.pbxIvr.update({ where: { id: req.params.id }, data })
      : await prisma.pbxIvr.create({ data: { userId, ...data } });
    if (req.params.id && row.userId !== userId) return fail(res, 404, 'URA não encontrada.');
    res.json(row);
  } catch (e) {
    next(e);
  }
};

exports.saveQueue = async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = req.userId;
    const name = str(b.name);
    if (!name) return fail(res, 400, 'Dê um nome para a fila.');
    const moh = await ownedAudio(userId, b.mohAudioId);
    if (moh === undefined) return fail(res, 400, 'Música de espera inválida.');
    const exts = await ensureAllExtensions(userId);
    const valid = new Map(exts.map((e) => [e.memberId, e]));
    const members = (Array.isArray(b.members) ? b.members : [])
      .map((m) => valid.get(m.memberId))
      .filter(Boolean)
      .map((e) => ({ memberId: e.memberId, name: e.name }));
    let overflowDest = null;
    if (b.overflowDest && b.overflowDest.type) {
      overflowDest = await destOk(userId, b.overflowDest);
      if (!overflowDest) return fail(res, 400, 'Destino quando ninguém atende inválido.');
      if (overflowDest.type === 'queue' && overflowDest.id === req.params.id) return fail(res, 400, 'A fila não pode transbordar para ela mesma.');
    }
    const data = {
      name,
      strategy: ['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear'].includes(b.strategy) ? b.strategy : 'rrmemory',
      ringSeconds: num(b.ringSeconds, 20, 5, 60),
      maxWaitSeconds: num(b.maxWaitSeconds, 300, 10, 3600),
      wrapupSeconds: num(b.wrapupSeconds, 5, 0, 120),
      mohAudioId: moh,
      announceHoldtime: !!b.announceHoldtime,
      joinEmpty: !!b.joinEmpty,
      members,
      overflowDest,
      enabled: b.enabled !== false
    };
    if (req.params.id) {
      const cur = await prisma.pbxQueue.findFirst({ where: { id: req.params.id, userId } });
      if (!cur) return fail(res, 404, 'Fila não encontrada.');
      return res.json(await prisma.pbxQueue.update({ where: { id: req.params.id }, data }));
    }
    res.json(await prisma.pbxQueue.create({ data: { userId, ...data } }));
  } catch (e) {
    next(e);
  }
};

function cleanHours(h) {
  if (!h || !h.enabled) return null;
  const days = {};
  for (const d of core.DAY_KEYS) {
    days[d] = (Array.isArray(h.days?.[d]) ? h.days[d] : [])
      .filter((r) => /^\d{2}:\d{2}$/.test(r?.[0]) && /^\d{2}:\d{2}$/.test(r?.[1]) && r[0] < r[1])
      .slice(0, 4)
      .map((r) => [r[0], r[1]]);
  }
  return { enabled: true, tz: /^[A-Za-z_\/+-]{3,40}$/.test(h.tz || '') ? h.tz : 'America/Sao_Paulo', days };
}

exports.saveRoute = async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = req.userId;
    const name = str(b.name);
    if (!name) return fail(res, 400, 'Dê um nome para a rota.');
    const dest = await destOk(userId, b.dest);
    if (!dest) return fail(res, 400, 'Escolha para onde a ligação vai.');
    let closedDest = null;
    const hours = cleanHours(b.hours);
    if (hours) {
      closedDest = await destOk(userId, b.closedDest || { type: 'hangup' });
      if (!closedDest) return fail(res, 400, 'Destino fora do horário inválido.');
    }
    // Sem tronco próprio, só vale número que a plataforma atribuiu à conta.
    const didDigits = str(b.did, 30).replace(/\D/g, '');
    if (didDigits) {
      const ownTrunk = await prisma.sipTrunk.count({ where: { userId, enabled: true } });
      if (!ownTrunk && !req.isPlatformAdmin) {
        const mine = await require('../services/pbx/didService').forAccount(userId);
        const hit = mine.find((d) => d.number === didDigits || d.number.endsWith(didDigits) || didDigits.endsWith(d.number));
        if (!hit) return fail(res, 400, 'Esse número não está atribuído à sua conta. Escolha um dos seus números (ou peça um ao administrador do serviço).');
        b.did = hit.number;
      }
    }
    let trunkId = null;
    if (b.trunkId) {
      const t = await prisma.sipTrunk.findFirst({ where: { id: String(b.trunkId), userId } });
      if (!t) return fail(res, 400, 'Tronco inválido.');
      trunkId = t.id;
    }
    const data = { name, trunkId, did: str(b.did, 30).replace(/\D/g, '') || null, dest, hours, closedDest, record: b.record !== false, enabled: b.enabled !== false };
    if (req.params.id) {
      const cur = await prisma.pbxInboundRoute.findFirst({ where: { id: req.params.id, userId } });
      if (!cur) return fail(res, 404, 'Rota não encontrada.');
      return res.json(await prisma.pbxInboundRoute.update({ where: { id: req.params.id }, data }));
    }
    res.json(await prisma.pbxInboundRoute.create({ data: { userId, ...data } }));
  } catch (e) {
    next(e);
  }
};

function remover(model, label) {
  return async (req, res, next) => {
    try {
      const id = req.params.id;
      if (model === 'pbxQueue' || model === 'pbxIvr') {
        const refs = [
          ...(await prisma.pbxInboundRoute.findMany({ where: { userId: req.userId } })).flatMap((r) => [r.dest, r.closedDest]),
          ...(await prisma.pbxIvr.findMany({ where: { userId: req.userId } })).flatMap((i) => [...(Array.isArray(i.options) ? i.options.map((o) => o.dest) : []), i.timeoutDest]),
          ...(await prisma.pbxQueue.findMany({ where: { userId: req.userId } })).map((q) => q.overflowDest)
        ];
        if (refs.some((d) => d && d.id === id)) return fail(res, 409, `Essa ${label} está sendo usada em uma rota, URA ou fila. Troque antes de apagar.`);
      }
      const r = await prisma[model].deleteMany({ where: { id, userId: req.userId } });
      if (!r.count) return fail(res, 404, 'Não encontrado.');
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  };
}
exports.deleteIvr = remover('pbxIvr', 'URA');
exports.deleteQueue = remover('pbxQueue', 'fila');
exports.deleteRoute = remover('pbxInboundRoute', 'rota');

// ------------------------------------------------------------------ histórico e gravações
exports.listCalls = async (req, res, next) => {
  try {
    const where = { userId: req.userId };
    if (['entrada', 'saida', 'ia'].includes(req.query.direction)) where.direction = req.query.direction;
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.q) where.OR = [{ fromNumber: { contains: String(req.query.q) } }, { toNumber: { contains: String(req.query.q) } }];
    const ah = require('../services/pbx/asteriskHost');
    const names = await ah.listNames(ah.dirs().rec);
    const rows = (await prisma.pbxCall.findMany({ where, orderBy: { startedAt: 'desc' }, take: 200 })).map((c) => {
      const has = (f) => {
        const p = f && svc.recordingPath(req.userId, f);
        return !!p && names.has(`${f}.wav`);
      };
      return { ...c, hasRecording: has(c.recordingFile), hasVoicemail: has(c.voicemailFile) };
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

exports.streamRecording = async (req, res, next) => {
  try {
    const c = await prisma.pbxCall.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!c) return fail(res, 404, 'Chamada não encontrada.');
    const file = req.query.kind === 'voicemail' ? c.voicemailFile : c.recordingFile;
    const p = file && svc.recordingPath(req.userId, file);
    const ah = require('../services/pbx/asteriskHost');
    const size = p ? await ah.size(p) : -1;
    if (!p || size < 0) return fail(res, 404, 'Gravação não encontrada no servidor.');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    res.set('Content-Type', 'audio/wav');
    res.set('Accept-Ranges', 'bytes');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${file}.wav"`);
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(size - 1, parseInt(range[2], 10)) : size - 1;
      if (start > end || start >= size) return res.status(416).end();
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return ah.readStream(p, { start, end }).pipe(res);
    }
    res.set('Content-Length', size);
    ah.readStream(p).pipe(res);
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ configuração do Asterisk
exports.config = async (req, res, next) => {
  try {
    res.json(await svc.loadPbxConfig(req.userId));
  } catch (e) {
    next(e);
  }
};

exports.apply = async (req, res, next) => {
  try {
    res.json(await svc.applyConfig(req.userId));
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

// ------------------------------------------------------------------ ligar sem pagar nada ao vendedor (click-to-call)
exports.clickToCall = async (req, res, next) => {
  try {
    const number = String(req.body.number || '').replace(/\D/g, '');
    if (number.length < 8) return fail(res, 400, 'Número inválido.');
    const ext = await prisma.sipExtension.findFirst({ where: { userId: req.userId, memberId: req.memberId } });
    if (!ext) return fail(res, 400, 'Você ainda não tem ramal. Abra a tela Telefone uma vez.');
    const tag = core.tagFor(req.userId);
    const name = `turbo-c2c-${crypto.randomUUID()}.call`;
    const body = [`Channel: PJSIP/${ext.extension}`, `CallerID: "Ligando para ${number}" <${number}>`, 'WaitTime: 30', 'MaxRetries: 0', `Context: turbo-agent-${tag}`, `Extension: ${number}`, 'Priority: 1', 'Archive: no'].join('\n') + '\n';
    try {
      await require('../services/pbx/asteriskHost').putCallFile(name, body);
    } catch (e) {
      return fail(res, 502, e.message);
    }
    res.json({ success: true, message: 'Seu telefone vai tocar; ao atender, ligamos para o cliente.' });
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ vozes e reconhecimento de fala (chaves)
const VOICE_PROVIDERS = {
  google: { fields: ['apiKey'], label: 'Google Cloud' },
  azure: { fields: ['apiKey', 'region'], label: 'Microsoft Azure' },
  polly: { fields: ['accessKeyId', 'secret', 'region'], label: 'Amazon Polly' },
  elevenlabs: { fields: ['apiKey'], label: 'ElevenLabs' }
};

exports.voiceEngines = async (req, res, next) => {
  try {
    const { describeStored } = require('../services/settingsHelpers');
    const out = {};
    for (const [p, meta] of Object.entries(VOICE_PROVIDERS)) {
      const stored = await require('../services/settingsHelpers').readStoredCredentials(req.userId, 'voice_engines', p).catch(() => ({}));
      const view = describeStored ? describeStored(stored) : {};
      out[p] = { label: meta.label, configured: Object.keys(stored).length > 0, fields: meta.fields, values: view };
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
};

exports.saveVoiceEngine = async (req, res, next) => {
  try {
    const p = req.params.provider;
    const meta = VOICE_PROVIDERS[p];
    if (!meta) return fail(res, 404, 'Fornecedor desconhecido.');
    const { mergeCredentials, persistCredentials } = require('../services/settingsHelpers');
    const incoming = {};
    for (const f of meta.fields) if (req.body[f] !== undefined) incoming[f] = String(req.body[f]).replace(/\s+/g, '').slice(0, 300);
    if (incoming.region && !/^[a-z0-9-]{3,30}$/i.test(incoming.region)) return fail(res, 400, 'Região inválida (ex.: brazilsouth, eastus, us-east-1).');
    const { merged, toDelete } = await mergeCredentials(req.userId, 'voice_engines', p, incoming);
    await persistCredentials(req.userId, 'voice_engines', p, merged, toDelete, { exclusive: false });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

exports.deleteVoiceEngine = async (req, res, next) => {
  try {
    if (!VOICE_PROVIDERS[req.params.provider]) return fail(res, 404, 'Fornecedor desconhecido.');
    await prisma.setting.deleteMany({ where: { userId: req.userId, category: 'voice_engines', provider: req.params.provider } });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

/** Ouvir amostra de qualquer voz, exatamente como o telefone vai receber (8 kHz). */
exports.voiceTest = async (req, res) => {
  try {
    const text = str(req.body.text, 300) || 'Olá! Tudo bem? Aqui é a assistente virtual. Posso te ajudar?';
    const pcm = await require('../services/pbx/voiceEngines').synthesize(req.userId, str(req.body.voice, 120), text, { fallback: false });
    res.type('audio/wav').send(buildWav(pcm, 8000));
  } catch (e) {
    fail(res, e.status === 400 ? 400 : 502, e.message);
  }
};

/** Teste do reconhecimento de fala: a voz fala uma frase, o motor escolhido transcreve. */
exports.sttTest = async (req, res) => {
  try {
    const engines = require('../services/pbx/voiceEngines');
    const phrase = 'quero saber o preço do produto';
    const pcm = await engines.synthesize(req.userId, str(req.body.voice, 120) || 'gemini:Kore', phrase, { fallback: false });
    const heard = await require('../services/pbx/stt').transcribe(req.userId, pcm, { provider: str(req.body.provider, 12) || 'auto', language: 'pt-BR' });
    res.json({ said: phrase, heard, ok: /pre[cç]o/i.test(heard) });
  } catch (e) {
    fail(res, e.status === 400 ? 400 : 502, e.message);
  }
};

// ------------------------------------------------------------------ números (DID) — só o administrador da plataforma
const dids = require('../services/pbx/didService');

exports.adminDids = async (req, res, next) => {
  try {
    const [rows, accounts, members] = await Promise.all([
      prisma.pbxDid.findMany({ orderBy: [{ createdAt: 'asc' }] }),
      prisma.account.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 }),
      prisma.member.findMany({ where: { role: 'owner' }, select: { accountId: true, email: true } })
    ]);
    const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
    const mailOf = new Map(members.map((m) => [m.accountId, m.email]));
    res.json({
      dids: rows.map((d) => ({ id: d.id, number: d.number, label: d.label, accountId: d.accountId, accountName: d.accountId ? nameOf.get(d.accountId) || d.accountId : null, assignedAt: d.assignedAt, monthlyFeeBrl: d.monthlyFeeBrl, nextBillAt: d.nextBillAt, lastBilledAt: d.lastBilledAt, overdueSince: d.overdueSince, suspendedAt: d.suspendedAt })),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, email: mailOf.get(a.id) || null })),
      settings: await dids.autoSettings()
    });
  } catch (e) {
    next(e);
  }
};

exports.adminAddDids = async (req, res, next) => {
  try {
    const out = await dids.addToPool(req.body.numbers, req.body.label);
    res.json({ added: out.added.length, skipped: out.skipped });
  } catch (e) {
    next(e);
  }
};

exports.adminAssignDids = async (req, res, next) => {
  try {
    const touched = new Set();
    const result = { done: 0, errors: [] };
    if (req.body.lines) {
      const r = await dids.assignMany(req.body.lines);
      r.done.forEach((d) => touched.add(d.accountId));
      result.done += r.done.length;
      result.errors.push(...r.errors);
    }
    if (Array.isArray(req.body.ids) && req.body.accountId) {
      for (const id of req.body.ids.slice(0, 500)) {
        try {
          const before = await prisma.pbxDid.findUnique({ where: { id: String(id) } });
          if (before?.accountId) touched.add(before.accountId); await dids.assign(String(id), String(req.body.accountId)); touched.add(String(req.body.accountId)); result.done += 1; } catch (e) { result.errors.push(e.message); }
      }
    }
    const plat = await require('../services/platformService').platformAccountIds();
    if (touched.size) applyQuietly([...touched, ...plat]);
    res.json(result);
  } catch (e) {
    next(e);
  }
};

exports.adminUnassignDids = async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 500);
    const touched = new Set();
    for (const id of ids) {
      const d = await prisma.pbxDid.findUnique({ where: { id: String(id) } });
      if (d?.accountId) touched.add(d.accountId);
      if (d) await dids.unassign(d.id);
    }
    applyQuietly([...touched, ...(await require('../services/platformService').platformAccountIds())]);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

exports.adminDeleteDid = async (req, res, next) => {
  try {
    const d = await prisma.pbxDid.findUnique({ where: { id: req.params.id } });
    if (!d) return fail(res, 404, 'Número não encontrado.');
    if (d.accountId) await dids.unassign(d.id);
    await prisma.pbxDid.delete({ where: { id: d.id } });
    applyQuietly([d.accountId, ...(await require('../services/platformService').platformAccountIds())].filter(Boolean));
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

exports.adminDidSettings = async (req, res, next) => {
  try {
    const s = await dids.saveSettings(req.body || {});
    const { platformId, ...rest } = s;
    res.json(rest);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

exports.adminUpdateDid = async (req, res, next) => {
  try {
    const before = await prisma.pbxDid.findUnique({ where: { id: req.params.id } });
    const row = await dids.updateDid(req.params.id, req.body || {});
    const plat = await require('../services/platformService').platformAccountIds();
    if (before?.accountId && (req.body.number !== undefined || req.body.suspended !== undefined)) applyQuietly([before.accountId, ...plat]);
    res.json(row);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

exports.adminDidHistory = async (req, res, next) => {
  try {
    const rows = await prisma.walletTx.findMany({ where: { type: 'did_fee', refId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 60 });
    res.json(rows.map((r) => ({ id: r.id, at: r.createdAt, amountBrl: r.amountBrl, description: r.description })));
  } catch (e) {
    next(e);
  }
};

/** Roda agora: "sweep" (atribuição automática) ou "billing" (mensalidades). */
exports.adminRunDidJob = async (req, res, next) => {
  try {
    const jobs = require('../jobs/didJob');
    const what = req.body.what === 'billing' ? 'billing' : 'sweep';
    res.json(what === 'billing' ? await jobs.runBillingNow() : await jobs.runSweepNow());
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ onde está o Asterisk (este servidor ou outro, por SSH)
exports.adminAsteriskHost = async (req, res, next) => {
  try {
    const host = require('../services/pbx/asteriskHost');
    await host.reload();
    res.json({ ...host.publicView(), hookBaseDefault: `http://127.0.0.1:${require('../config/env').port}/api/pbx-hook`, audioSocketPort: require('../config/env').audioSocketPort });
  } catch (e) {
    next(e);
  }
};

exports.adminSaveAsteriskHost = async (req, res, next) => {
  try {
    const host = require('../services/pbx/asteriskHost');
    await host.save(req.body || {});
    res.json(host.publicView());
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

exports.adminTestAsteriskHost = async (req, res, next) => {
  try {
    res.json(await require('../services/pbx/asteriskHost').test());
  } catch (e) {
    next(e);
  }
};

/** Regrava e recarrega a configuração de TODAS as contas que usam telefonia (útil após trocar de servidor). */
exports.adminApplyAll = async (req, res, next) => {
  try {
    const plat = await require('../services/platformService').platformAccountIds();
    const ids = new Set(plat);
    for (const t of await prisma.sipTrunk.findMany({ select: { userId: true } })) ids.add(t.userId);
    for (const d of await prisma.pbxDid.findMany({ where: { accountId: { not: null } }, select: { accountId: true } })) ids.add(d.accountId);
    for (const e of await prisma.sipExtension.findMany({ select: { userId: true } })) ids.add(e.userId);
    const results = [];
    for (const id of ids) {
      try { const r = await svc.applyConfig(id); results.push({ id, ok: true, warnings: r.warnings || [] }); } catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    res.json({ total: results.length, ok: results.filter((r) => r.ok).length, results });
  } catch (e) {
    next(e);
  }
};

// ------------------------------------------------------------------ painel ao vivo e supervisão
exports.live = async (req, res, next) => {
  try {
    res.json(await require('../services/pbx/pbxLive').liveForUser(prisma, req.userId));
  } catch (e) {
    next(e);
  }
};

exports.spy = async (req, res, next) => {
  try {
    const live = require('../services/pbx/pbxLive');
    const mode = String(req.body.mode || 'listen');
    const channel = String(req.body.channel || '');
    const ext = await prisma.sipExtension.findFirst({ where: { userId: req.userId, memberId: req.memberId } });
    if (!ext) return fail(res, 400, 'Você ainda não tem ramal. Abra a tela Telefone (SIP) uma vez e deixe-a aberta para ouvir.');
    const now = await live.liveForUser(prisma, req.userId);
    const target = (now.calls || []).find((c) => c.channel === channel && c.spyable);
    if (!target) return fail(res, 404, 'Essa chamada não está mais ativa.');
    if (channel.startsWith(`PJSIP/${ext.extension}-`)) return fail(res, 400, 'Você não pode escutar a própria chamada.');
    const out = await live.spyCallFile({ supervisorExt: ext.extension, target: channel, mode, tag: core.tagFor(req.userId) });
    res.json({ success: true, message: 'Seu telefone vai tocar; ao atender você escuta a chamada.', ...out });
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};

exports.hangupLive = async (req, res, next) => {
  try {
    const live = require('../services/pbx/pbxLive');
    const channel = String(req.body.channel || '');
    const now = await live.liveForUser(prisma, req.userId);
    if (!(now.calls || []).some((c) => c.channel === channel)) return fail(res, 404, 'Essa chamada não está mais ativa.');
    const r = await live.hangupChannel(channel);
    res.json({ success: r.ok });
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    next(e);
  }
};
