// backend/src/services/pbx/pbxConfig.js
// Gera os arquivos do Asterisk para o PBX da conta: rotas de entrada, URA, filas, gravação, recado de voz.
// O portal só descreve; quem atende e grava é o Asterisk.
const env = require('../../config/env');
const { buildAsteriskConfig } = require('../smsgw/asteriskConfig');
const core = require('./pbxCore');

const V = (s) => s.replace(/@\{/g, '${'); // "@{X}" vira "${X}" (evita confundir com templates do JavaScript)

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function recPath(tag) {
  return `${env.asteriskRecordingsDir}/${tag}-@{UNIQUEID}.wav`;
}

/** Arquivo compartilhado por todas as contas: portas, gancho de fim de chamada e ponte da IA. */
function buildShared(base) {
  const token = core.hookToken();
  const hook = core.localHookBase();
  const L = [];
  L.push('; Gerado pelo Turbo Prospect. Inclua UMA vez no extensions.conf:  #include extensions_turbo_shared.conf');
  L.push('[turbo-hangup]');
  L.push('; Roda sozinho quando qualquer chamada do PBX termina: avisa o portal (histórico + gravação).');
  L.push(
    V(
      `exten => s,1,Set(TPR=@{CURL(${hook}/event?t=${token}&tag=@{TP_TAG}&uid=@{UNIQUEID}&dir=@{TP_DIR}&from=@{URIENCODE(@{TP_FROM})}&to=@{URIENCODE(@{TP_TO})}&trunk=@{TP_TRUNK}&ai=@{TP_AI}&route=@{TP_ROUTE}&queue=@{TP_QUEUE}&ext=@{TP_EXT}&rec=@{TP_REC}&vm=@{TP_VM}&dur=@{CDR(duration)}&bill=@{CDR(billsec)}&ds=@{DIALSTATUS}&qs=@{QUEUESTATUS}&cause=@{HANGUPCAUSE})})`
    )
  );
  L.push('same => n,Return()');
  L.push('');
  L.push('[turbo-ai]');
  L.push('; Ligação da IA: o Asterisk liga, ao atender manda o áudio para o portal (AudioSocket) e a IA conversa.');
  L.push(V('exten => s,1,NoOp(IA @{TP_CALLID})'));
  L.push('same => n,Set(CHANNEL(hangup_handler_push)=turbo-ai-hangup,s,1)');
  L.push(V(`same => n,GotoIf($["@{TP_REC}" = ""]?norec)`));
  L.push(V(`same => n,MixMonitor(${env.asteriskRecordingsDir}/@{TP_REC}.wav)`));
  L.push(V(`same => n(norec),AudioSocket(@{TP_CALLID},127.0.0.1:${env.audioSocketPort})`));
  L.push(V(`same => n,Set(NEXT=@{CURL(${hook}/ai-next?t=${token}&callId=@{TP_CALLID})})`));
  L.push(V('same => n,GotoIf($["@{NEXT:0:6}" = "QUEUE:"]?queue)'));
  L.push(V('same => n,GotoIf($["@{NEXT:0:5}" = "DIAL:"]?dial)'));
  L.push('same => n,Hangup()');
  L.push(V('same => n(queue),Set(TP_QUEUE=@{NEXT:6})'));
  L.push(V('same => n,Queue(@{NEXT:6},,,,300)'));
  L.push('same => n,Hangup()');
  L.push(V('same => n(dial),Dial(PJSIP/@{TP_PREFIX}@{NEXT:5}@@{TP_TRUNK},45)'));
  L.push('same => n,Hangup()');
  L.push('');
  L.push('[turbo-ai-hangup]');
  L.push(V(`exten => s,1,Set(TPR=@{CURL(${hook}/ai-end?t=${token}&callId=@{TP_CALLID}&ds=@{DIALSTATUS}&qs=@{QUEUESTATUS})})`));
  L.push('same => n,Return()');
  return L.join('\n');
}

function destLines(d, c, depth = 0) {
  const L = [];
  if (!d || !d.type) return ['same => n,Hangup()'];
  const { tag } = c;
  if (d.type === 'queue') {
    const q = c.queues.get(d.id);
    if (!q) return ['; fila não encontrada', 'same => n,Hangup()'];
    L.push(V(`same => n,Set(TP_QUEUE=${core.queueName(tag, q)})`));
    L.push(V(`same => n,Queue(${core.queueName(tag, q)},,,,${Math.max(10, q.maxWaitSeconds || 300)})`));
    const lbl = `qdone${(c.n = (c.n || 0) + 1)}`;
    L.push(V(`same => n,GotoIf($["@{QUEUESTATUS}" = "COMPLETEAGENT" | "@{QUEUESTATUS}" = "COMPLETECALLER"]?${lbl})`));
    if (q.overflowDest && depth < 1) L.push(...destLines(q.overflowDest, c, depth + 1));
    else {
      L.push('same => n,Playback(vm-nobodyavail)');
      L.push('same => n,Hangup()');
    }
    L.push(`same => n(${lbl}),Hangup()`);
  } else if (d.type === 'ivr') {
    const ivr = c.ivrs.get(d.id);
    if (!ivr) return ['; URA não encontrada', 'same => n,Hangup()'];
    L.push(`same => n,Goto(${core.ivrContext(tag, ivr)},s,1)`);
  } else if (d.type === 'extension') {
    const ext = d.value || c.extByMember.get(d.id);
    if (!ext) return ['; ramal não encontrado', 'same => n,Hangup()'];
    L.push(V(`same => n,Set(TP_EXT=${ext})`));
    L.push(`same => n,Dial(PJSIP/${ext},30)`);
    const lbl = `ddone${(c.n = (c.n || 0) + 1)}`;
    L.push(V(`same => n,GotoIf($["@{DIALSTATUS}" = "ANSWER"]?${lbl})`));
    L.push('same => n,Playback(vm-nobodyavail)');
    L.push(`same => n(${lbl}),Hangup()`);
  } else if (d.type === 'number') {
    const n = digitsOnly(d.value);
    if (!n) return ['; número vazio', 'same => n,Hangup()'];
    L.push(`same => n,Goto(turbo-out-${tag},${n},1)`);
  } else if (d.type === 'voicemail') {
    L.push(V(`same => n,Set(TP_VM=${tag}-vm-@{UNIQUEID})`));
    L.push('same => n,Answer()');
    L.push('same => n,Wait(1)');
    L.push('same => n,Playback(vm-intro)');
    L.push(V(`same => n,Record(${env.asteriskRecordingsDir}/@{TP_VM}.wav,3,120,k)`));
    L.push('same => n,Playback(vm-goodbye)');
    L.push('same => n,Hangup()');
  } else if (d.type === 'ai') {
    const hook = core.localHookBase();
    const token = core.hookToken();
    const lbl = `aiok${(c.n = (c.n || 0) + 1)}`;
    L.push('same => n,Answer()');
    L.push(V(`same => n,Set(TP_CALLID=@{CURL(${hook}/ai-start?t=${token}&tag=${tag}&from=@{URIENCODE(@{CALLERID(num)})}&to=@{URIENCODE(@{EXTEN})}&uid=@{UNIQUEID})})`));
    L.push(V(`same => n,GotoIf($["@{TP_CALLID}" != "NO" & "@{TP_CALLID}" != ""]?${lbl})`));
    L.push('same => n,Playback(vm-nobodyavail)');
    L.push('same => n,Hangup()');
    L.push(V(`same => n(${lbl}),Set(TP_AI=1)`));
    L.push('same => n,Goto(turbo-ai,s,1)');
  } else if (d.type === 'conference') {
    L.push(V(`same => n,ConfBridge(${tag}${digitsOnly(d.value) || '1'})`));
    L.push('same => n,Hangup()');
  } else {
    L.push('same => n,Hangup()');
  }
  return L;
}

function buildPbxConfig({ userId, trunks, extensions, ivrs = [], queues = [], routes = [], settings = {} }) {
  const tag = core.tagFor(userId);
  const base = buildAsteriskConfig(trunks, extensions, { tag });
  const c = {
    tag,
    queues: new Map(queues.filter((q) => q.enabled).map((q) => [q.id, q])),
    ivrs: new Map(ivrs.filter((i) => i.enabled).map((i) => [i.id, i])),
    extByMember: new Map(extensions.filter((x) => x.memberId).map((x) => [x.memberId, x.extension]))
  };
  const warnings = [];
  const E = [];
  E.push('; ============================================================================');
  E.push('; Gerado pelo Turbo Prospect (PBX). Não edite à mão: gere de novo.');
  E.push(`; Inclua no extensions.conf:  #include extensions_turbo_${tag}.conf`);
  E.push('; ============================================================================');
  E.push('');

  // ---- saída (pelos troncos, na ordem)
  const out = [];
  out.push('exten => _X.,1,NoOp(Saída ${EXTEN})'.replace('${', '${'));
  base.active.forEach((t, i) => {
    if (i > 0) out.push('same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?done)');
    out.push(`same => n,Dial(PJSIP/${t.dialPrefix || ''}\${EXTEN}@${base.trunks[i]},60)`);
  });
  out.push('same => n(done),Hangup()');
  if (!base.active.length) warnings.push('Nenhum tronco SIP ativo: ligações de saída não terão por onde sair.');

  E.push(`[turbo-out-${tag}]`);
  E.push(...out);
  E.push('');

  // ---- vendedores discando pelo navegador
  const hangupPush = 'same => n,Set(CHANNEL(hangup_handler_push)=turbo-hangup,s,1)';
  const setVars = (dir) => [
    V(`same => n,Set(__TP_TAG=${tag})`),
    V(`same => n,Set(TP_DIR=${dir})`),
    V('same => n,Set(TP_FROM=@{CALLERID(num)})'),
    V('same => n,Set(TP_TO=@{EXTEN})'),
    V('same => n,Set(TP_TRUNK=@{CHANNEL(endpoint)})')
  ];
  E.push(`[turbo-agent-${tag}]`);
  E.push('; Ramal para ramal (código da conta + 4 dígitos).');
  E.push(`exten => _${tag}XXXX,1,Dial(PJSIP/\${EXTEN},30)`);
  E.push('same => n,Hangup()');
  E.push('; Vendedor disca para fora: toca o ramal dele, sai por um tronco e (se ativado) grava.');
  E.push('exten => _X.,1,NoOp(Saída do ramal ${CALLERID(num)} para ${EXTEN})');
  E.push(hangupPush);
  E.push(...setVars('out'));
  E.push(V('same => n,Set(TP_EXT=@{CALLERID(num)})'));
  E.push('; Saldo pré-pago: o portal responde NO (sem saldo), YES ou YES:<segundos que o saldo aguenta>.');
  E.push(V(`same => n,Set(TPA=@{CURL(${core.localHookBase()}/allow?t=${core.hookToken()}&tag=${tag})})`));
  E.push(V('same => n,GotoIf($["@{TPA}" = "NO"]?blocked)'));
  E.push(V('same => n,GotoIf($["@{TPA:0:4}" = "YES:"]?limit:go)'));
  E.push(V('same => n(limit),Set(TIMEOUT(absolute)=@{TPA:4})'));
  E.push('same => n(go),NoOp(Saldo ok)');
  if (settings.recordOutbound !== 'false') {
    E.push(V(`same => n,Set(TP_REC=${tag}-@{UNIQUEID})`));
    E.push(V(`same => n,MixMonitor(${env.asteriskRecordingsDir}/@{TP_REC}.wav,b)`));
  }
  E.push(`same => n,Goto(turbo-out-${tag},\${EXTEN},1)`);
  E.push('same => n(blocked),NoOp(Sem saldo pré-pago)');
  E.push('same => n,Playback(silence/1)');
  E.push('same => n,Hangup(21)');
  E.push('');

  // ---- entrada
  const active = routes.filter((r) => r.enabled);
  const trunkEndpoint = new Map(base.active.map((t, i) => [t.id, base.trunks[i]]));
  const withDid = active.filter((r) => digitsOnly(r.did));
  const onlyTrunk = active.filter((r) => !digitsOnly(r.did) && r.trunkId);
  const fallback = active.find((r) => !digitsOnly(r.did) && !r.trunkId);
  E.push(`[turbo-in-${tag}]`);
  E.push('; Ligação recebida pelos troncos: escolhe a rota de entrada (número chamado > tronco > padrão).');
  E.push('exten => _X.,1,NoOp(Entrada de ${CALLERID(num)} para ${EXTEN})');
  E.push(hangupPush);
  E.push(...setVars('in'));
  withDid.forEach((r) => {
    const did = digitsOnly(r.did);
    const tr = r.trunkId ? trunkEndpoint.get(r.trunkId) : null;
    const cond = tr ? `$["\${EXTEN:-${did.length}}" = "${did}" & "\${TP_TRUNK}" = "${tr}"]` : `$["\${EXTEN:-${did.length}}" = "${did}"]`;
    E.push(`same => n,GotoIf(${cond}?${core.routeContext(tag, r)},s,1)`);
  });
  onlyTrunk.forEach((r) => {
    const tr = trunkEndpoint.get(r.trunkId);
    if (!tr) {
      warnings.push(`A rota "${r.name}" usa um tronco desativado ou apagado.`);
      return;
    }
    E.push(`same => n,GotoIf($["\${TP_TRUNK}" = "${tr}"]?${core.routeContext(tag, r)},s,1)`);
  });
  if (fallback) E.push(`same => n,Goto(${core.routeContext(tag, fallback)},s,1)`);
  else {
    const first = extensions[0];
    if (first) {
      E.push(`same => n,Dial(${extensions.map((x) => `PJSIP/${x.extension}`).join('&')},40)`);
    }
    E.push('same => n,Playback(vm-nobodyavail)');
    E.push('same => n,Hangup()');
    warnings.push('Sem rota padrão: ligações sem rota tocam em todos os ramais da equipe.');
  }
  E.push('');

  active.forEach((r) => {
    const ctx = core.routeContext(tag, r);
    E.push(`; ---- Rota: ${r.name} ----`);
    E.push(`[${ctx}]`);
    E.push(V(`exten => s,1,Set(TP_ROUTE=${r.id})`));
    const ranges = core.hoursToRanges(r.hours);
    if (ranges.length) {
      const tz = /^[A-Za-z_\/+-]{3,40}$/.test(r.hours?.tz || '') ? r.hours.tz : 'America/Sao_Paulo';
      ranges.forEach((x) => E.push(`same => n,GotoIfTime(${x.range},${x.day},*,*,${tz}?open)`));
      E.push('same => n(closed),NoOp(Fora do horário)');
      E.push(...destLines(r.closedDest || { type: 'hangup' }, c));
      E.push('same => n(open),NoOp(Dentro do horário)');
    }
    E.push('same => n,Answer()');
    if (r.record !== false && settings.recordInbound !== 'false') {
      E.push(V(`same => n,Set(TP_REC=${tag}-@{UNIQUEID})`));
      E.push(V(`same => n,MixMonitor(${env.asteriskRecordingsDir}/@{TP_REC}.wav,b)`));
    }
    E.push(...destLines(r.dest, c));
    E.push('');
  });

  // ---- URAs
  [...c.ivrs.values()].forEach((ivr) => {
    const ctx = core.ivrContext(tag, ivr);
    const opts = (Array.isArray(ivr.options) ? ivr.options : []).filter((o) => /^[0-9*#]$/.test(String(o.digit)));
    const max = Math.max(1, Math.min(5, ivr.maxRetries || 2));
    E.push(`; ---- URA: ${ivr.name} ----`);
    E.push(`[${ctx}]`);
    E.push('exten => s,1,Answer()');
    E.push('same => n,Set(TP_TRIES=0)');
    E.push(V('same => n(menu),Set(TP_TRIES=$[@{TP_TRIES}+1])'));
    if (ivr.greetingAudioId) E.push(`same => n,Background(${core.soundPath(tag, ivr.greetingAudioId)})`);
    E.push(`same => n,WaitExten(${Math.max(2, ivr.timeoutSeconds || 6)})`);
    opts.forEach((o) => {
      E.push(`exten => ${o.digit},1,NoOp(Opção ${o.digit})`);
      E.push(...destLines(o.dest, c));
    });
    if (ivr.extensionDial) {
      E.push(`exten => _XXXX,1,Set(TP_EXT=${tag}\${EXTEN})`);
      E.push(`same => n,Dial(PJSIP/${tag}\${EXTEN},30)`);
      E.push('same => n,Hangup()');
    }
    const give = destLines(ivr.timeoutDest || { type: 'hangup' }, c).map((l) => l);
    E.push('exten => i,1,NoOp(Opção inválida)');
    if (ivr.invalidAudioId) E.push(`same => n,Playback(${core.soundPath(tag, ivr.invalidAudioId)})`);
    E.push(V(`same => n,GotoIf($[@{TP_TRIES}>=${max}]?giveup)`));
    E.push('same => n,Goto(s,menu)');
    E.push('same => n(giveup),NoOp(Desistiu)');
    E.push(...give);
    E.push('exten => t,1,NoOp(Sem resposta)');
    E.push(V(`same => n,GotoIf($[@{TP_TRIES}>=${max}]?giveup)`));
    E.push('same => n,Goto(s,menu)');
    E.push('same => n(giveup),NoOp(Desistiu)');
    E.push(...give);
    E.push('exten => h,1,Hangup()');
    E.push('');
  });

  // ---- filas
  const Q = [];
  const M = [];
  Q.push(`; Gerado pelo Turbo Prospect. Inclua no queues.conf:  #include queues_turbo_${tag}.conf`);
  M.push(`; Gerado pelo Turbo Prospect. Inclua no musiconhold.conf:  #include musiconhold_turbo_${tag}.conf`);
  queues.filter((q) => q.enabled).forEach((q) => {
    const name = core.queueName(tag, q);
    const members = (Array.isArray(q.members) ? q.members : []).map((m) => ({ m, ext: c.extByMember.get(m.memberId) || m.extension })).filter((x) => x.ext);
    const strategy = ['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear'].includes(q.strategy) ? q.strategy : 'rrmemory';
    Q.push(`[${name}]`);
    Q.push(`; ${q.name}`);
    Q.push(`strategy=${strategy}`);
    Q.push(`timeout=${Math.max(5, q.ringSeconds || 20)}`);
    Q.push(`wrapuptime=${Math.max(0, q.wrapupSeconds || 0)}`);
    Q.push('retry=3');
    Q.push('ringinuse=no');
    Q.push('autofill=yes');
    Q.push(`joinempty=${q.joinEmpty ? 'yes' : 'unavailable,invalid'}`);
    Q.push(`leavewhenempty=${q.joinEmpty ? 'no' : 'unavailable,invalid'}`);
    Q.push(`announce-holdtime=${q.announceHoldtime ? 'yes' : 'no'}`);
    Q.push(`reportholdtime=${q.announceHoldtime ? 'yes' : 'no'}`);
    if (q.mohAudioId) Q.push(`musiconhold=turbo-${tag}-${core.short(q.mohAudioId)}`);
    members.forEach((x) => Q.push(`member => PJSIP/${x.ext},0,${String(x.m.name || x.ext).replace(/[,\n]/g, ' ')}`));
    if (!members.length) warnings.push(`A fila "${q.name}" não tem atendentes.`);
    Q.push('');
    if (q.mohAudioId) {
      M.push(`[turbo-${tag}-${core.short(q.mohAudioId)}]\nmode=files\ndirectory=${env.asteriskSoundsDir}/${tag}/moh-${q.mohAudioId}\nsort=alpha\n`);
    }
  });

  return {
    tag,
    shared: buildShared(),
    transports: base.transports,
    pjsip: base.pjsip,
    extensions: E.join('\n'),
    queues: Q.join('\n'),
    moh: M.join('\n'),
    warnings,
    trunks: base.trunks,
    extensionCount: base.extensionCount
  };
}

module.exports = { buildPbxConfig, buildShared, destLines };
