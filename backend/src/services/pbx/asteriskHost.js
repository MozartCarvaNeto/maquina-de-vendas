// backend/src/services/pbx/asteriskHost.js
// Onde o Asterisk está: neste mesmo servidor (padrão) ou em OUTRO servidor, acessado por SSH.
// Todo o resto do sistema (config, ligações, áudios, gravações) passa por aqui.
// A configuração é feita pelo administrador na tela Telefonia PBX > Servidor Asterisk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const env = require('../../config/env');

const CATEGORY = 'platform_telecom';
const PROVIDER = 'asterisk_host';
const KEYS = ['mode', 'host', 'port', 'user', 'secret', 'hookBase', 'audioHost', 'confDir', 'spoolDir', 'soundsDir', 'recordingsDir'];

let cfg = null; // cache síncrono
let allowedIps = new Set();
let keyFile = null;
let spawnImpl = spawn;
let execFileImpl = execFile;

function defaults() {
  return {
    mode: 'local', host: '', port: '22', user: 'root', secret: '',
    hookBase: '', audioHost: '',
    confDir: process.env.ASTERISK_CONF_DIR || '/etc/asterisk',
    spoolDir: env.asteriskSpoolDir,
    soundsDir: env.asteriskSoundsDir,
    recordingsDir: env.asteriskRecordingsDir
  };
}

function normalize(v = {}) {
  const d = defaults();
  const o = { ...d };
  for (const k of KEYS) if (v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== '') o[k] = String(v[k]).trim();
  o.mode = o.mode === 'ssh' ? 'ssh' : 'local';
  return o;
}

function current() {
  return cfg || normalize({});
}
const isRemote = () => current().mode === 'ssh';

async function platformId() {
  const ids = await require('../platformService').platformAccountIds();
  return ids[0] || null;
}

async function reload() {
  try {
    const pid = await platformId();
    const stored = pid ? await require('../settingsHelpers').readStoredCredentials(pid, CATEGORY, PROVIDER) : {};
    cfg = normalize(stored);
    allowedIps = new Set();
    if (cfg.mode === 'ssh' && cfg.host) {
      if (/^[0-9.]+$|:/.test(cfg.host)) allowedIps.add(cfg.host);
      else { try { for (const a of await require('dns').promises.lookup(cfg.host, { all: true })) allowedIps.add(a.address); } catch (_) { /* sem DNS */ } }
    }
  } catch (e) {
    cfg = cfg || normalize({});
  }
  return cfg;
}

/** Salva (segredo em branco = mantém o que já está salvo). Não mexe nos outros provedores de plataform_telecom. */
async function save(input = {}) {
  const pid = await platformId();
  if (!pid) throw Object.assign(new Error('Nenhuma conta de administrador da plataforma encontrada (SUPERADMIN_EMAILS).'), { status: 400 });
  const h = require('../settingsHelpers');
  const incoming = {};
  for (const k of KEYS) if (input[k] !== undefined) incoming[k] = input[k];
  if (incoming.mode && !['local', 'ssh'].includes(incoming.mode)) throw Object.assign(new Error('Modo inválido.'), { status: 400 });
  if (incoming.mode === 'ssh' && !String(incoming.host || (await h.readStoredCredentials(pid, CATEGORY, PROVIDER)).host || '').trim()) {
    throw Object.assign(new Error('Informe o endereço (IP ou nome) do servidor do Asterisk.'), { status: 400 });
  }
  for (const k of ['host', 'user']) if (incoming[k] && !/^[A-Za-z0-9_.@-]+$/.test(String(incoming[k]).trim())) throw Object.assign(new Error(`Valor inválido em "${k}".`), { status: 400 });
  if (incoming.port && !/^\d{1,5}$/.test(String(incoming.port).trim())) throw Object.assign(new Error('Porta inválida.'), { status: 400 });
  for (const k of ['confDir', 'spoolDir', 'soundsDir', 'recordingsDir']) if (incoming[k] && !/^\/[A-Za-z0-9_./-]*$/.test(String(incoming[k]).trim())) throw Object.assign(new Error(`Pasta inválida em "${k}" (use caminho absoluto, sem espaços).`), { status: 400 });
  if (incoming.hookBase && !/^https?:\/\/[^\s"']+$/.test(String(incoming.hookBase).trim())) throw Object.assign(new Error('Endereço de retorno inválido (use http://IP:porta/api/pbx-hook).'), { status: 400 });
  if (incoming.audioHost && !/^[A-Za-z0-9_.-]+$/.test(String(incoming.audioHost).trim())) throw Object.assign(new Error('Endereço do AudioSocket inválido.'), { status: 400 });
  const { merged, toDelete } = await h.mergeCredentials(pid, CATEGORY, PROVIDER, incoming);
  // quem não veio na requisição continua como estava
  const stored = await h.readStoredCredentials(pid, CATEGORY, PROVIDER);
  for (const k of Object.keys(stored)) if (merged[k] === undefined && !toDelete.includes(k)) merged[k] = stored[k];
  await h.persistCredentials(pid, CATEGORY, PROVIDER, merged, toDelete, { exclusive: false });
  keyFile = null;
  return reload();
}

/** Versão segura para o navegador (sem a chave privada). */
function publicView() {
  const c = current();
  const { secret, ...rest } = c;
  return { ...rest, hasKey: Boolean(secret), keyHint: secret ? `••••${secret.replace(/\s/g, '').slice(-6)}` : '' };
}

// ---------------------------------------------------------------- endereços usados no dialplan
/** Endereço (visto do Asterisk) para o Asterisk avisar este sistema. */
function hookBase() {
  const c = current();
  if (c.hookBase) return c.hookBase.replace(/\/+$/, '');
  return `http://127.0.0.1:${env.port}/api/pbx-hook`;
}
/** Onde o Asterisk encontra o AudioSocket (a ponte de IA, que roda no sistema). */
function audioSocketAddr() {
  const c = current();
  return `${isRemote() ? c.audioHost || '127.0.0.1' : '127.0.0.1'}:${env.audioSocketPort}`;
}
/** A ponte da IA só aceita conexões do Asterisk (sem senha no protocolo). */
function audioAllowed(addr) {
  if (!isRemote()) return true;
  const a = String(addr || '').replace(/^::ffff:/, '');
  return allowedIps.has(a);
}

/** Em que interface a ponte escuta. Remoto: todas (0.0.0.0) — o firewall DEVE liberar só o IP do Asterisk. */
function audioSocketBind() {
  return isRemote() ? '0.0.0.0' : '127.0.0.1';
}

const dirs = () => {
  const c = current();
  return { conf: c.confDir, spool: c.spoolDir, sounds: c.soundsDir, rec: c.recordingsDir };
};

// ---------------------------------------------------------------- SSH
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function ensureKeyFile() {
  const c = current();
  if (keyFile && fs.existsSync(keyFile)) return keyFile;
  const f = path.join(os.tmpdir(), `turbo-ast-${crypto.randomBytes(6).toString('hex')}.key`);
  let key = String(c.secret || '').replace(/\r/g, '').trim();
  if (!key) throw Object.assign(new Error('Chave privada SSH não cadastrada.'), { status: 400 });
  key = `${key}\n`;
  fs.writeFileSync(f, key, { mode: 0o600 });
  keyFile = f;
  return f;
}

function sshArgs() {
  const c = current();
  return ['-i', ensureKeyFile(), '-p', String(c.port || 22), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', `${c.user}@${c.host}`];
}

/** Roda um comando no servidor do Asterisk (shell remoto) com stdin opcional. */
function remoteRun(command, { input = null, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let args;
    try { args = [...sshArgs(), command]; } catch (e) { return resolve({ ok: false, out: e.message, code: -1 }); }
    const p = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* ok */ } finish({ ok: false, out: `${out}\ntempo esgotado`.trim(), code: -2 }); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => finish({ ok: false, out: e.message, code: -1 }));
    p.on('close', (code) => finish({ ok: code === 0, out: out.trim(), code }));
    if (input !== null) p.stdin.end(input); else p.stdin.end();
  });
}

// ---------------------------------------------------------------- operações
/** asterisk -rx "<cmd>" */
async function cli(cmd, timeout = 15000) {
  if (isRemote()) {
    const r = await remoteRun(`asterisk -rx ${q(cmd)}`, { timeout });
    return { ok: r.ok, out: r.out };
  }
  return new Promise((resolve) => {
    execFileImpl('asterisk', ['-rx', cmd], { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });
}

function wrapErr(msg, status = 502) {
  return Object.assign(new Error(msg), { status });
}

/** Grava um arquivo (Buffer/string) no servidor do Asterisk, sem deixar arquivo pela metade. */
async function writeFile(dest, content, { mode = 0o644, mkdir = false } = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (isRemote()) {
    const tmp = `${dest}.tmp${crypto.randomBytes(3).toString('hex')}`;
    const pre = mkdir ? `mkdir -p ${q(path.posix.dirname(dest))} && ` : '';
    const r = await remoteRun(`${pre}cat > ${q(tmp)} && chmod ${mode.toString(8)} ${q(tmp)} && mv -f ${q(tmp)} ${q(dest)}`, { input: buf, timeout: 60000 });
    if (!r.ok) throw wrapErr(`Não consegui gravar ${dest} no servidor do Asterisk (${r.out || 'erro de SSH'}).`);
    return;
  }
  if (mkdir) fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${crypto.randomBytes(3).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, buf, { mode });
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ok */ }
    // alguns discos não aceitam rename na mesma pasta de spool: tenta direto
    try { fs.writeFileSync(dest, buf, { mode }); } catch (err) { throw wrapErr(`Não consegui gravar ${dest} (${err.code || err.message}).`); }
  }
}

/** Entrega um arquivo .call na pasta outgoing (o Asterisk só enxerga o arquivo pronto). */
async function putCallFile(name, text) {
  const dest = path.posix.join(dirs().spool, name);
  try {
    await writeFile(dest, text, { mode: 0o644 });
  } catch (e) {
    throw wrapErr(`Não consegui entregar a ligação ao Asterisk em ${dirs().spool} (${e.message}). Confira a conexão com o servidor do Asterisk e as permissões da pasta.`);
  }
}

async function rm(target, { recursive = false } = {}) {
  if (isRemote()) { await remoteRun(`rm -f${recursive ? 'r' : ''} ${q(target)}`); return; }
  fs.rmSync(target, { force: true, recursive });
}

async function exists(target) {
  if (isRemote()) return (await remoteRun(`test -f ${q(target)}`)).ok;
  return fs.existsSync(target);
}

async function size(target) {
  if (isRemote()) {
    const r = await remoteRun(`stat -c %s ${q(target)}`);
    const n = parseInt(r.out, 10);
    return r.ok && n >= 0 ? n : -1;
  }
  try { return fs.statSync(target).size; } catch (_) { return -1; }
}

/** Stream de um arquivo (ou de um pedaço dele). */
function readStream(target, { start, end } = {}) {
  if (!isRemote()) return fs.createReadStream(target, start !== undefined ? { start, end } : undefined);
  let cmd = `cat ${q(target)}`;
  if (start !== undefined) cmd = `tail -c +${Number(start) + 1} ${q(target)} | head -c ${Number(end) - Number(start) + 1}`;
  const p = spawnImpl('ssh', [...sshArgs(), cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.on('close', () => { try { p.kill(); } catch (_) { /* ok */ } });
  return p.stdout;
}

/** Nomes dos arquivos de uma pasta (uma só consulta, mesmo no servidor remoto). */
async function listNames(dir) {
  if (isRemote()) {
    const r = await remoteRun(`ls -1 ${q(dir)}`);
    return new Set(r.ok ? r.out.split('\n').map((x) => x.trim()).filter(Boolean) : []);
  }
  try { return new Set(fs.readdirSync(dir)); } catch (_) { return new Set(); }
}

async function readFile(target) {
  if (!isRemote()) return fs.readFileSync(target);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = readStream(target);
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}

/** Teste da conexão: SSH funciona? Asterisk responde? As pastas existem e aceitam gravação? */
async function test() {
  const c = current();
  const res = { mode: c.mode, steps: [] };
  const add = (name, ok, detail = '') => res.steps.push({ name, ok, detail });
  const run = isRemote() ? (cmd) => remoteRun(cmd) : null;
  if (isRemote()) {
    const r = await remoteRun('echo ok');
    add('Conexão SSH', r.ok && /ok/.test(r.out), r.ok ? '' : r.out);
    if (!r.ok) { res.ok = false; return res; }
  }
  const v = await cli('core show version');
  add('Asterisk responde', v.ok && /Asterisk/i.test(v.out), v.ok ? v.out.split('\n')[0] : v.out || 'o comando "asterisk" não respondeu');
  for (const [label, dir] of [['Pasta de configuração', dirs().conf], ['Pasta de ligações (outgoing)', dirs().spool], ['Pasta de áudios', dirs().sounds], ['Pasta de gravações', dirs().rec]]) {
    let ok;
    if (run) ok = (await run(`test -d ${q(dir)} -a -w ${q(dir)}`)).ok;
    else { try { fs.accessSync(dir, fs.constants.W_OK); ok = true; } catch (_) { ok = false; } }
    add(label, ok, ok ? dir : `${dir} não existe ou não aceita gravação para o usuário`);
  }
  res.ok = res.steps.every((s) => s.ok);
  return res;
}

module.exports = {
  KEYS, current, isRemote, reload, save, publicView, hookBase, audioSocketAddr, audioSocketBind, audioAllowed, dirs,
  cli, writeFile, putCallFile, rm, exists, size, readStream, readFile, listNames, test, remoteRun,
  _set: (o) => { if (o.spawn) spawnImpl = o.spawn; if (o.execFile) execFileImpl = o.execFile; if (o.cfg) { cfg = normalize(o.cfg); keyFile = null; } if (o.ips) allowedIps = new Set(o.ips); },
  _normalize: normalize
};
