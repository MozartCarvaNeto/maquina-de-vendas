// backend/src/services/telephony/AsteriskProvider.js
// Ligações da IA pelo Asterisk do próprio servidor (sem Twilio): o provedor "liga" escrevendo um arquivo de
// chamada na pasta do Asterisk; quando o cliente atende, o áudio vai para a ponte da IA (AudioSocket).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ITelephonyProvider = require('./ITelephonyProvider');
const env = require('../../config/env');

class AsteriskProvider extends ITelephonyProvider {
  constructor(credentials = {}) {
    super();
    this.userId = credentials.userId;
    this.trunkId = credentials.trunkId || '';
    this.spoolDir = credentials.spoolDir || env.asteriskSpoolDir;
    this.providerName = 'asterisk';
    this.dialect = 'asterisk'; // não usa endereços de retorno (webhooks): a conversa passa pela ponte
  }

  async pickTrunk() {
    const prisma = require('../../config/db');
    const { buildAsteriskConfig } = require('../smsgw/asteriskConfig');
    const core = require('../pbx/pbxCore');
    // tronco do próprio cliente (se houver) ou o da plataforma (venda por minutos)
    let owner = this.userId;
    let trunks = await prisma.sipTrunk.findMany({ where: { userId: owner, enabled: true } });
    if (!trunks.length) {
      for (const pid of await require('../platformService').platformAccountIds()) {
        trunks = await prisma.sipTrunk.findMany({ where: { userId: pid, enabled: true } });
        if (trunks.length) { owner = pid; break; }
      }
    }
    if (!trunks.length) {
      const err = new Error('Nenhum tronco SIP disponível. O administrador do serviço precisa cadastrar um tronco ativo em Gateway de telecom > Voz.');
      err.status = 400;
      err.fatal = true;
      throw err;
    }
    const built = buildAsteriskConfig(trunks, [], { tag: core.tagFor(owner) });
    let idx = this.trunkId ? built.active.findIndex((t) => t.id === this.trunkId) : 0;
    if (idx < 0) idx = 0;
    return { trunk: built.active[idx], endpoint: built.trunks[idx] };
  }

  async startCall({ to, from, ringTimeoutSeconds = 30, timeLimitSeconds, statusCallbackUrl, recordingStatusCallbackUrl, twiml }) {
    const callId = /callId=([0-9a-f-]{36})/i.exec(statusCallbackUrl || '')?.[1];
    if (twiml && callId && /\/robocalls\//.test(statusCallbackUrl || '')) {
      return this.startRoboCall({ to, from, callId, twiml, ringTimeoutSeconds, timeLimitSeconds, record: Boolean(recordingStatusCallbackUrl) });
    }
    if (twiml) {
      const err = new Error('Este tipo de ligação com roteiro em TwiML só roda pela Twilio (a URA reversa e as ligações da IA já têm suporte próprio no Asterisk).');
      err.status = 400;
      err.fatal = true;
      throw err;
    }
    if (!callId) return this.startDialerLeg({ to, from, ringTimeoutSeconds, timeLimitSeconds });
    const allow = await require('../walletService').voiceAllowance(this.userId);
    if (!allow.allowed) {
      const err = new Error('Saldo insuficiente para ligar. Peça uma recarga ao administrador do serviço.');
      err.status = 402;
      err.fatal = true;
      throw err;
    }
    const { trunk, endpoint } = await this.pickTrunk();
    const digits = String(to).replace(/\D/g, '');
    const lines = [
      `Channel: PJSIP/${trunk.dialPrefix || ''}${digits}@${endpoint}`,
      `CallerID: "${String(from || '').replace(/"/g, '')}" <${String(from || '').replace(/\D/g, '')}>`,
      `WaitTime: ${Math.max(10, ringTimeoutSeconds)}`,
      'MaxRetries: 0',
      'Context: turbo-ai',
      'Extension: s',
      'Priority: 1',
      'Archive: no',
      `Setvar: TP_CALLID=${callId}`,
      `Setvar: TP_TRUNK=${endpoint}`,
      `Setvar: TP_PREFIX=${trunk.dialPrefix || ''}`,
      `Setvar: TP_TAG=${require('../pbx/pbxCore').tagFor(this.userId)}`
    ];
    if (recordingStatusCallbackUrl) lines.push(`Setvar: TP_REC=ai-${callId}`);
    const limit = [timeLimitSeconds, allow.maxSeconds].filter((x) => x > 0);
    if (limit.length) lines.push(`Setvar: TIMEOUT(absolute)=${Math.round(Math.min(...limit))}`);
    const name = `turbo-ai-${callId}.call`;
    const tmp = path.join(os.tmpdir(), `${name}.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o644 });
    const dest = path.join(this.spoolDir, name);
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      try {
        fs.copyFileSync(tmp, dest); // pastas em discos diferentes
        fs.rmSync(tmp, { force: true });
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        const e2 = new Error(`Não consegui entregar a ligação ao Asterisk em ${this.spoolDir} (${err.code || err.message}). Confira se o sistema roda no mesmo servidor e tem permissão nessa pasta.`);
        e2.status = 502;
        throw e2;
      }
    }
    require('../pbx/aiBridge').watchOrigination(callId, Math.max(10, ringTimeoutSeconds) + 20);
    return { providerCallId: `asterisk:${callId}`, status: 'queued' };
  }

  async hangupCall({ providerCallId } = {}) {
    const hex = /^ast-([0-9a-f]{32})$/.exec(String(providerCallId || ''))?.[1];
    if (!hex) return { success: true }; // ligação da IA: a ponte/Asterisk encerra sozinho
    const live = require('../pbx/pbxLive');
    const { out } = await live._asterisk('core show channels concise');
    const mine = live.parseChannels(out).filter((c) => c.channel.includes(`/${'L'}${hex}@`) || c.channel.includes(`/A${hex}@`));
    for (const c of mine) await live._asterisk(`channel request hangup ${c.channel}`);
    return { success: true };
  }

  // ---- discador (vendedor / automático): o lead cai numa sala de conferência e o vendedor entra depois ----
  async dialString(digits, trunkInfo) {
    return `PJSIP/${trunkInfo.trunk.dialPrefix || ''}${digits}@${trunkInfo.endpoint}`;
  }

  writeCallFile(name, lines) {
    const tmp = path.join(os.tmpdir(), `${name}.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o644 });
    const dest = path.join(this.spoolDir, name);
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      try {
        fs.copyFileSync(tmp, dest);
        fs.rmSync(tmp, { force: true });
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        const e2 = new Error(`Não consegui entregar a ligação ao Asterisk em ${this.spoolDir} (${err.code || err.message}). Confira se o sistema roda no mesmo servidor e tem permissão nessa pasta.`);
        e2.status = 502;
        throw e2;
      }
    }
  }

  async checkAllowance() {
    const allow = await require('../walletService').voiceAllowance(this.userId);
    if (!allow.allowed) {
      const err = new Error('Saldo insuficiente para ligar. Peça uma recarga ao administrador do serviço.');
      err.status = 402;
      err.fatal = true;
      throw err;
    }
    return allow;
  }

  legLines({ sid, leg, dialStr, wait, from, room, timeLimit, robo }) {
    const hex = sid.slice(4);
    const num = String(from || '').replace(/\D/g, '');
    const lines = [
      `Channel: Local/${leg === 'lead' ? 'L' : 'A'}${hex}@turbo-dial-leg/n`,
      `CallerID: "${String(from || '').replace(/"/g, '')}" <${num}>`,
      `WaitTime: ${wait + 15}`,
      'MaxRetries: 0',
      ...(robo ? ['Context: turbo-robo', 'Extension: s', 'Priority: 1'] : ['Application: ConfBridge', `Data: ${room}`]),
      'Archive: no',
      `Setvar: TP_SID=${sid}`,
      `Setvar: TP_LEG=${leg}`,
      `Setvar: TP_WAIT=${wait}`,
      `Setvar: TP_DIALSTR=${dialStr}`,
      `Setvar: TP_TAG=${require('../pbx/pbxCore').tagFor(this.userId)}`
    ];
    if (robo) lines.push(`Setvar: TP_CALLID=${robo.callId}`, `Setvar: TP_INTRO=${robo.intro}`, `Setvar: TP_REC=${robo.rec || ''}`);
    if (timeLimit > 0) lines.push(`Setvar: TIMEOUT(absolute)=${Math.round(timeLimit)}`);
    return lines;
  }

  static roomFor(sid) {
    return `dl${String(sid).replace(/^ast-/, '')}`;
  }

  async startDialerLeg({ to, from, ringTimeoutSeconds = 30, timeLimitSeconds }) {
    const allow = await this.checkAllowance();
    const info = await this.pickTrunk();
    const digits = String(to).replace(/\D/g, '');
    const sid = `ast-${crypto.randomBytes(16).toString('hex')}`;
    const limit = [timeLimitSeconds, allow.maxSeconds].filter((x) => x > 0);
    this.writeCallFile(`turbo-dial-${sid}.call`, this.legLines({
      sid, leg: 'lead', dialStr: await this.dialString(digits, info), wait: Math.max(10, ringTimeoutSeconds), from, room: AsteriskProvider.roomFor(sid), timeLimit: limit.length ? Math.min(...limit) : 0
    }));
    return { providerCallId: sid, status: 'queued' };
  }

  /** URA reversa (robô): toca o áudio de abertura, lê a tecla; se não houver tecla, a ponte escuta a fala. */
  async startRoboCall({ to, from, callId, twiml, ringTimeoutSeconds = 25, timeLimitSeconds, record }) {
    const allow = await this.checkAllowance();
    const info = await this.pickTrunk();
    const m = /\/uploads\/robocall-audio\/([0-9a-f-]{36})\/([^<"?]+)/i.exec(String(twiml));
    if (!m) throw Object.assign(new Error('Áudio de abertura da campanha não encontrado.'), { status: 400, fatal: true });
    const src = path.join(__dirname, '../../../uploads/robocall-audio', m[1], decodeURIComponent(m[2]));
    if (!fs.existsSync(src)) throw Object.assign(new Error('O arquivo de áudio de abertura da campanha não existe mais no servidor.'), { status: 400, fatal: true });
    const dir = path.join(env.asteriskSoundsDir, 'robo');
    const base = path.join(dir, `${m[1]}-${Math.round(fs.statSync(src).mtimeMs)}`);
    if (!fs.existsSync(`${base}.wav`)) {
      const { wav } = await require('../pbx/wav').normalizeToAsteriskWav(fs.readFileSync(src), src).catch((e) => {
        throw Object.assign(e, { status: 400, fatal: true });
      });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${base}.wav`, wav);
    }
    const sid = `ast-${crypto.randomBytes(16).toString('hex')}`;
    const limit = [timeLimitSeconds, allow.maxSeconds].filter((x) => x > 0);
    this.writeCallFile(`turbo-dial-${sid}.call`, this.legLines({
      sid, leg: 'lead', dialStr: await this.dialString(String(to).replace(/\D/g, ''), info), wait: Math.max(10, ringTimeoutSeconds), from, room: '', timeLimit: limit.length ? Math.min(...limit) : 0,
      robo: { callId, intro: base, rec: record ? `${env.asteriskRecordingsDir}/robo-${callId}` : '' }
    }));
    return { providerCallId: sid, status: 'queued' };
  }

  /** Registrado = o telefone do navegador do vendedor está ligado e atende por ramal. */
  async extensionOnline(ext) {
    const { out } = await require('../pbx/pbxLive')._asterisk('pjsip show contacts');
    return new RegExp(`Contact:\\s+${ext}/`).test(out) && !/Unavail/.test(out.split('\n').filter((l) => new RegExp(`Contact:\\s+${ext}/`).test(l)).join('\n'));
  }

  async bridgeToAgent({ providerCallId, from, agentPhoneNumber, agentId, recordingEnabled, ringTimeoutSeconds = 30 }) {
    const prisma = require('../../config/db');
    const info = await this.pickTrunk();
    let dialStr = null;
    if (agentId) {
      const member = await prisma.member.findFirst({ where: { agentId } });
      const ext = member ? await prisma.sipExtension.findFirst({ where: { userId: this.userId, memberId: member.id } }) : null;
      if (ext && (await this.extensionOnline(ext.extension))) dialStr = `PJSIP/${ext.extension}`;
    }
    if (!dialStr) dialStr = await this.dialString(String(agentPhoneNumber || '').replace(/\D/g, ''), info);
    const sid = `ast-${crypto.randomBytes(16).toString('hex')}`;
    this.writeCallFile(`turbo-dial-${sid}.call`, this.legLines({
      sid, leg: 'agent', dialStr, wait: ringTimeoutSeconds, from, room: AsteriskProvider.roomFor(providerCallId), timeLimit: 0
    }));
    let recordingUrl;
    if (recordingEnabled) {
      // grava a conversa inteira (cliente + vendedor) a partir do canal do cliente que já está na sala
      const hex = providerCallId.replace(/^ast-/, '');
      const live = require('../pbx/pbxLive');
      const { out } = await live._asterisk('core show channels concise');
      const ch = live.parseChannels(out).find((c) => c.channel.includes(`/L${hex}@`) && c.channel.endsWith(';1'));
      if (ch) {
        const r = await live._asterisk(`mixmonitor start ${ch.channel} ${env.asteriskRecordingsDir}/dial-${hex}.wav`);
        if (r.ok) recordingUrl = `local:dial-${hex}.wav`;
      }
    }
    return { agentCallSid: sid, recordingUrl };
  }

  async validateCredentials() {
    try {
      fs.accessSync(this.spoolDir, fs.constants.W_OK);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `O sistema não consegue escrever em ${this.spoolDir}. O Asterisk precisa estar instalado no mesmo servidor (e a pasta liberada para o usuário do sistema).` };
    }
  }

}

module.exports = AsteriskProvider;
