// backend/src/services/pbx/aiBridge.js
// Ponte entre o Asterisk e o Agente de IA: o Asterisk manda o áudio do cliente (AudioSocket); aqui detectamos
// quando ele fala, transcrevemos, a IA (aiCallService.processTurn) decide a resposta, geramos a voz e tocamos de volta.
// A conversa continua escrita em TwiML; esta ponte "interpreta" esse TwiML (falar, ouvir, transferir, desligar).
const { Vad, FRAME_MS } = require('./vad');
const { parseMarkup } = require('./markup');
const { FRAME_BYTES, createAudioSocketServer } = require('./audioSocket');
const { wavToSlin8k, int16ToBuffer } = require('./wav');

const MAX_STEPS = 80;
const pendingNext = new Map(); // callId -> {kind:'queue'|'dial', target}
const ended = new Set();
const origination = new Map(); // callId -> timer (esperando a pessoa atender)
const digits = new Map(); // callId -> tecla apertada na abertura do robô

const defaultDeps = {
  get prisma() {
    return require('../../config/db');
  },
  get ai() {
    return require('../ai/voice/aiCallService');
  },
  async tts(userId, text, voice, language) {
    return require('./voiceEngines').synthesize(userId, voice || 'gemini:Kore', text, { language });
  },
  async stt(userId, pcm, opts) {
    return require('./stt').transcribe(userId, pcm, opts);
  },
  async settings(userId) {
    return require('./pbxCore').getPbxSettings(userId);
  },
  async handoff(userId) {
    const core = require('./pbxCore');
    const s = await core.getPbxSettings(userId);
    if (!s.aiHandoffQueueId) return null;
    const q = await require('../../config/db').pbxQueue.findFirst({ where: { id: s.aiHandoffQueueId, userId, enabled: true } });
    return q ? core.queueName(core.tagFor(userId), q) : null;
  },
  frameMs: FRAME_MS
};

/** Uma conversa: toca falas com interrupção e escuta o cliente. */
class Conversation {
  constructor(session, { frameMs }) {
    this.session = session;
    this.frameMs = frameMs;
    this.vad = new Vad();
    this.playing = false;
    this.interruptible = false;
    this.stopPlay = false;
    this.speechStarted = false;
    this.waiter = null;
    this.closed = false;
    session.on('audio', (f) => this.onAudio(f));
    session.on('close', () => {
      this.closed = true;
      this.stopPlay = true;
      if (this.waiter) this.waiter.resolve(null);
    });
  }

  onAudio(frame) {
    if (this.closed) return;
    if (this.playing && !this.interruptible) return; // fala protegida: não escuta por cima
    const r = this.vad.push(frame);
    if (r.event === 'start') {
      this.speechStarted = true;
      if (this.playing) this.stopPlay = true; // cliente interrompeu
    } else if (r.event === 'end') {
      this.speechStarted = false;
      if (this.waiter && !this.playing) this.waiter.resolve(r.audio);
      else this.pendingAudio = r.audio; // terminou de falar ainda durante a fala: guarda
    }
  }

  async play(pcm, interruptible) {
    this.playing = true;
    this.interruptible = interruptible;
    this.stopPlay = false;
    if (interruptible) this.vad.reset();
    const t0 = Date.now();
    let i = 0;
    for (let off = 0; off < pcm.length && !this.stopPlay && !this.closed; off += FRAME_BYTES, i += 1) {
      let frame = pcm.subarray(off, off + FRAME_BYTES);
      if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
      this.session.sendAudio(frame);
      const wait = t0 + (i + 1) * this.frameMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else if (i % 50 === 0) await new Promise((r) => setImmediate(r));
    }
    const interrupted = this.stopPlay && !this.closed;
    this.playing = false;
    this.interruptible = false;
    return interrupted ? 'interrupted' : 'done';
  }

  /** Espera o cliente falar. Devolve o áudio dele, ou null se ficou em silêncio. */
  listen(timeoutMs) {
    if (this.pendingAudio) {
      const a = this.pendingAudio;
      this.pendingAudio = null;
      return Promise.resolve(a);
    }
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        clearInterval(poll);
        this.waiter = null;
        resolve(v);
      };
      this.waiter = { resolve: done };
      const timer = setTimeout(() => {
        // se já começou a falar, deixa terminar (o VAD limita a 20 s)
        if (!this.speechStarted) done(null);
      }, timeoutMs);
      const poll = setInterval(() => {
        if (this.closed) done(null);
      }, 200);
    });
  }
}

function setDigit(callId, d) {
  if (d) digits.set(callId, d);
}

/** Som de resposta do robô: arquivo enviado pelo cliente (WAV/MP3) ou, sem arquivo, a fala padrão pela voz do sistema. */
async function roboAnswerPcm(call, campaign, qualified, deps) {
  const fname = qualified ? campaign.interestedAudioFilename : campaign.notInterestedAudioFilename;
  if (fname) {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, '../../../uploads/robocall-audio', campaign.id, fname);
      const { wav } = await require('./wav').normalizeToAsteriskWav(fs.readFileSync(file), file);
      return int16ToBuffer(wavToSlin8k(wav));
    } catch (e) {
      console.warn('⚠️ Áudio de resposta do robô não pôde ser tocado, usando voz do sistema:', e.message);
    }
  }
  const text = qualified
    ? 'Perfeito! Vamos continuar o seu atendimento pelo WhatsApp, é só aguardar a nossa mensagem. Obrigado!'
    : 'Sem problemas. Obrigado pelo seu tempo, tenha um ótimo dia!';
  return deps.tts(call.userId, text, null, 'pt-BR');
}

/** URA reversa pelo Asterisk: tecla (já lida no plano de discagem) ou fala -> mesma decisão da versão Twilio. */
async function runRobo(session, call, convo, deps) {
  const prisma = deps.prisma;
  const full = await prisma.call.findUnique({ where: { id: call.id }, include: { roboCallCampaign: true, lead: true } });
  const campaign = full.roboCallCampaign;
  const robo = deps.robo || require('../roboCallService');
  let heard = '';
  const digit = digits.get(call.id) || '';
  digits.delete(call.id);
  if (!digit && campaign.useSpeechRecognition) {
    const audio = await convo.listen(6000);
    if (audio && audio.length > FRAME_BYTES * 10) {
      try {
        heard = await deps.stt(call.userId, audio, { language: 'pt-BR', provider: 'auto' });
      } catch (e) {
        console.warn('⚠️ Reconhecimento de fala (robô) falhou:', e.message);
      }
    }
  }
  let qualified = false;
  if (full.qualified === null || full.qualified === undefined) {
    ({ qualified } = await robo.registerResponse(full, { digits: digit, speech: heard, confidence: heard ? 0.9 : 0 }));
  } else {
    qualified = Boolean(full.qualified);
  }
  const noAnswer = !digit && !heard;
  const pcm = noAnswer
    ? await deps.tts(call.userId, 'Não identificamos sua resposta. Obrigado pela atenção, até logo.', null, 'pt-BR')
    : await roboAnswerPcm(call, campaign, qualified, deps);
  await convo.play(pcm, false);
  session.hangup();
}

async function runCall(session, deps = defaultDeps) {
  const callId = session.id;
  const prisma = deps.prisma;
  const timer = origination.get(callId);
  if (timer) {
    clearTimeout(timer);
    origination.delete(callId);
  }
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return session.hangup();
  const convo = new Conversation(session, deps);
  await prisma.call
    .update({ where: { id: callId }, data: { status: 'atendida', answeredAt: call.answeredAt || new Date() } })
    .catch(() => {});

  if (call.roboCallCampaignId) {
    session.isRobo = true; // o fim vem do aviso da perna do cliente (dial-event), não daqui
    return runRobo(session, call, convo, deps);
  }

  let sttProvider = 'auto';
  try {
    if (deps.settings) sttProvider = (await deps.settings(call.userId)).sttProvider || 'auto';
  } catch (_) { /* usa o padrão */ }
  let xml = await deps.ai.handleAnswerCall(callId);
  let leaving = false;
  const speak = async (step, interruptible) => {
    if (!step.text) return 'done';
    const pcm = await deps.tts(call.userId, step.text, step.voice, step.language);
    return convo.play(pcm, interruptible);
  };

  for (let n = 0; n < MAX_STEPS && !leaving && !convo.closed; n += 1) {
    const steps = parseMarkup(xml);
    let nextXml = null;
    for (const step of steps) {
      if (convo.closed) break;
      if (step.type === 'say') await speak(step, false);
      else if (step.type === 'pause') await new Promise((r) => setTimeout(r, step.seconds * 1000));
      else if (step.type === 'gather') {
        let barge = 'done';
        for (const p of step.prompts) {
          barge = await speak(p, true);
          if (barge === 'interrupted') break;
        }
        const audio = await convo.listen(step.timeout * 1000);
        let heard = '';
        if (audio && audio.length > FRAME_BYTES * 10) {
          try {
            heard = await deps.stt(call.userId, audio, { language: step.language, provider: sttProvider });
          } catch (e) {
            console.warn('⚠️ Reconhecimento de fala falhou:', e.message);
          }
        }
        nextXml = await deps.ai.processTurn({ callId, speech: heard, confidence: heard ? 0.9 : 0 });
        break;
      } else if (step.type === 'dial') {
        const queue = await deps.handoff(call.userId).catch(() => null);
        pendingNext.set(callId, queue ? { kind: 'queue', target: queue } : { kind: 'dial', target: String(step.number).replace(/\D/g, '') });
        leaving = true;
        break;
      } else if (step.type === 'hangup') {
        leaving = true;
        break;
      }
    }
    if (nextXml == null) break; // acabou o roteiro sem novo turno
    xml = nextXml;
  }
  session.hangup();
}

async function handleSession(session, deps = defaultDeps) {
  try {
    await runCall(session, deps);
  } catch (e) {
    console.error(`❌ Ponte da IA (${session.id}):`, e.message);
    session.hangup();
  }
  if (session.isRobo) return;
  // Rede de segurança: se o Asterisk não avisar o fim da ligação, fechamos daqui a pouco.
  const t = setTimeout(() => endCall(session.id, {}, deps).catch(() => {}), pendingNext.has(session.id) ? 120000 : 6000);
  t.unref();
}

/** Fim da ligação (avisado pelo Asterisk ou pela rede de segurança). Seguro chamar mais de uma vez. */
async function endCall(callId, { dialStatus } = {}, deps = defaultDeps) {
  if (ended.has(callId)) return false;
  ended.add(callId);
  setTimeout(() => ended.delete(callId), 10 * 60 * 1000).unref();
  const prisma = deps.prisma;
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return false;
  const handoff = pendingNext.get(callId);
  pendingNext.delete(callId);
  if (handoff) {
    const status = handoff.kind === 'queue' ? (dialStatus || '') : dialStatus || '';
    await deps.ai.handleDialResult({ callId, dialStatus: status === 'ANSWER' ? 'completed' : String(status || 'no-answer').toLowerCase() });
  }
  const terminal = deps.ai.TERMINAL_STATUSES || [];
  const endedAt = new Date();
  const data = { endedAt };
  if (!terminal.includes(call.status)) data.status = 'encerrada';
  if (call.answeredAt) data.durationSeconds = Math.round((endedAt.getTime() - new Date(call.answeredAt).getTime()) / 1000);
  else data.durationSeconds = 0;
  await prisma.call.update({ where: { id: callId }, data });
  await deps.ai.finalizeAiCall(callId);
  const io = global.socketIoInstance;
  if (io) io.to(`user:${call.userId}`).emit('aicall:progress', { campaignId: call.aiCallCampaignId });
  return true;
}

/** Se ninguém atender (ou o Asterisk não conseguir ligar), encerra a ligação como "sem resposta". */
function watchOrigination(callId, seconds, deps = defaultDeps) {
  const timer = setTimeout(async () => {
    origination.delete(callId);
    try {
      const call = await deps.prisma.call.findUnique({ where: { id: callId } });
      if (call && !call.answeredAt) {
        await deps.prisma.call.update({ where: { id: callId }, data: { status: 'sem_resposta' } });
        await endCall(callId, {}, deps);
      }
    } catch (e) {
      console.error('Ponte da IA (espera):', e.message);
    }
  }, seconds * 1000);
  timer.unref();
  origination.set(callId, timer);
}

/**
 * Ligação recebida atendida pela IA. Acha (ou cria) o lead pelo telefone, cria a ligação "entrada" e a sessão
 * com a saudação receptiva. Devolve o id da ligação (usado no AudioSocket) ou null se não houver agente configurado.
 */
async function startInbound(userId, { from, to, uniqueId }, deps = defaultDeps) {
  const prisma = deps.prisma;
  const s = await deps.settings(userId);
  if (!s.aiInboundAgentId) return null;
  const agent = await prisma.aiVoiceAgent.findFirst({ where: { id: s.aiInboundAgentId, userId } });
  if (!agent) return null;
  const digits = String(from || '').replace(/\D/g, '');
  const variants = new Set([digits]);
  if (digits.startsWith('55')) variants.add(digits.slice(2));
  else if (digits.length >= 10) variants.add(`55${digits}`);
  let lead = digits ? await prisma.lead.findFirst({ where: { userId, phone: { in: [...variants].filter(Boolean) } } }) : null;
  if (!lead) {
    lead = await prisma.lead.create({
      data: { userId, name: digits ? `Ligação ${digits}` : 'Ligação sem número', phone: digits || null, consentSource: 'ligacao_receptiva', source: 'ligacao_receptiva', status: 'novo' }
    });
  }
  const greetingRaw = (s.aiInboundGreeting || '').trim() || `Olá, aqui é a ${agent.agentName} da ${agent.companyName}. Como posso ajudar você?`;
  let greeting = greetingRaw.replace(/\{\{?\s*(agentName|agente)\s*\}?\}/g, agent.agentName).replace(/\{\{?\s*(companyName|empresa)\s*\}?\}/g, agent.companyName);
  if (agent.recordCalls && !/gravad/i.test(greeting)) greeting = `${greeting} Esta ligação pode ser gravada.`;
  const callId = require('crypto').randomUUID();
  const now = new Date();
  await prisma.call.create({
    data: { id: callId, userId, leadId: lead.id, provider: 'asterisk', fromNumber: digits || 'desconhecido', toNumber: String(to || ''), direction: 'entrada', answeredBy: 'ia', status: 'atendida', startedAt: now, answeredAt: now }
  });
  const raw = JSON.stringify({ say: greeting, action: 'continue', outcome: null, collected: {}, callbackAt: null, callbackNote: null, summary: '' });
  await prisma.aiCallSession.create({
    data: { userId, callId, agentId: agent.id, leadId: lead.id, transcript: [{ role: 'agent', text: greeting, raw, at: now.toISOString() }] }
  });
  return callId;
}

/** O que o Asterisk deve fazer depois que a IA terminou de falar ("QUEUE:nome", "DIAL:numero" ou "HANGUP"). */
function nextAction(callId) {
  const p = pendingNext.get(callId);
  if (!p) return 'HANGUP';
  return p.kind === 'queue' ? `QUEUE:${p.target}` : `DIAL:${p.target}`;
}

let server = null;
function start({ port, host = '127.0.0.1' } = {}) {
  if (server) return server;
  const ah = require('./asteriskHost');
  server = createAudioSocketServer((session) => handleSession(session), { host, allow: (addr) => ah.audioAllowed(addr) });
  server.on('error', (e) => console.error('AudioSocket (IA no Asterisk):', e.message));
  server.listen(port, host, () => console.log(`🎙️  Ponte da IA com o Asterisk ouvindo em ${host}:${port}`));
  return server;
}

module.exports = { setDigit, start, startInbound, handleSession, runCall, endCall, watchOrigination, nextAction, Conversation, _pending: pendingNext };
