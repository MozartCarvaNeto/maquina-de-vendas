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
    const trunks = await prisma.sipTrunk.findMany({ where: { userId: this.userId, enabled: true } });
    if (!trunks.length) {
      const err = new Error('Cadastre um tronco SIP ativo em Gateway de telecom > Voz para a IA ligar pelo Asterisk.');
      err.status = 400;
      err.fatal = true;
      throw err;
    }
    const built = buildAsteriskConfig(trunks, [], { tag: core.tagFor(this.userId) });
    let idx = this.trunkId ? built.active.findIndex((t) => t.id === this.trunkId) : 0;
    if (idx < 0) idx = 0;
    return { trunk: built.active[idx], endpoint: built.trunks[idx] };
  }

  async startCall({ to, from, ringTimeoutSeconds = 30, timeLimitSeconds, statusCallbackUrl, recordingStatusCallbackUrl }) {
    const callId = /callId=([0-9a-f-]{36})/i.exec(statusCallbackUrl || '')?.[1];
    if (!callId) throw new Error('Ligação sem identificador (callId).');
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

  async hangupCall() {
    return { success: true }; // o Asterisk encerra pelo limite de tempo/pela própria ponte
  }

  async validateCredentials() {
    try {
      fs.accessSync(this.spoolDir, fs.constants.W_OK);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `O sistema não consegue escrever em ${this.spoolDir}. O Asterisk precisa estar instalado no mesmo servidor (e a pasta liberada para o usuário do sistema).` };
    }
  }

  async bridgeToAgent() {
    const err = new Error('A transferência para vendedor pelo Asterisk é feita pela ponte da IA (fila ou número).');
    err.status = 400;
    throw err;
  }
}

module.exports = AsteriskProvider;
