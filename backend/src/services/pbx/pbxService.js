// backend/src/services/pbx/pbxService.js
const fs = require('fs');
const path = require('path');
const host = require('./asteriskHost');
const prisma = require('../../config/db');
const env = require('../../config/env');
const core = require('./pbxCore');
const { buildPbxConfig } = require('./pbxConfig');
const { ensureAllExtensions } = require('../smsgw/sipExtensions');

async function loadPbxConfig(userId) {
  const [trunks, extensions, ivrs, queues, routes, settings] = await Promise.all([
    prisma.sipTrunk.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    ensureAllExtensions(userId),
    prisma.pbxIvr.findMany({ where: { userId } }),
    prisma.pbxQueue.findMany({ where: { userId } }),
    prisma.pbxInboundRoute.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    core.getPbxSettings(userId)
  ]);
  let sharedTrunks = [];
  if (!trunks.some((t) => t.enabled)) {
    const { buildAsteriskConfig } = require('../smsgw/asteriskConfig');
    for (const pid of await require('../platformService').platformAccountIds()) {
      if (pid === userId) continue;
      const pt = await prisma.sipTrunk.findMany({ where: { userId: pid, enabled: true }, orderBy: { createdAt: 'asc' } });
      if (pt.length) {
        const b = buildAsteriskConfig(pt, [], { tag: core.tagFor(pid) });
        sharedTrunks = b.active.map((t, i) => ({ dialPrefix: t.dialPrefix, endpoint: b.trunks[i] }));
        break;
      }
    }
  }
  let didDispatch = [];
  if (await require('../platformService').isPlatformAccount(userId)) didDispatch = await require('./didService').dispatchRules();
  return buildPbxConfig({ userId, trunks, extensions, ivrs, queues, routes, settings, sharedTrunks, didDispatch });
}

const CONF_DIR = () => host.dirs().conf;

function asterisk(args) {
  return host.cli(args, 15000);
}

/** Grava os arquivos na pasta do Asterisk e manda ele reler. Só funciona se o sistema roda no mesmo servidor. */
async function applyConfig(userId) {
  const cfg = await loadPbxConfig(userId);
  const dir = CONF_DIR();
  const files = {
    'pjsip_turbo_transports.conf': cfg.transports,
    [`pjsip_turbo_${cfg.tag}.conf`]: cfg.pjsip,
    'extensions_turbo_shared.conf': cfg.shared,
    [`extensions_turbo_${cfg.tag}.conf`]: cfg.extensions,
    [`queues_turbo_${cfg.tag}.conf`]: cfg.queues,
    [`musiconhold_turbo_${cfg.tag}.conf`]: cfg.moh
  };
  if (!host.isRemote()) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (_) {
      const e = new Error(`Sem permissão para gravar em ${dir}. Siga o passo de instalação do guia (ou baixe os arquivos e copie à mão).`);
      e.status = 400;
      throw e;
    }
  }
  try {
    for (const [name, content] of Object.entries(files)) await host.writeFile(path.posix.join(dir, name), `${content}\n`, { mode: 0o640 });
  } catch (e) {
    e.status = 400;
    throw e;
  }
  const steps = [];
  for (const cmd of ['module reload res_pjsip.so', 'dialplan reload', 'module reload app_queue.so', 'moh reload']) {
    steps.push({ cmd, ...(await asterisk(cmd)) });
  }
  return { files: Object.keys(files), reload: steps, warnings: cfg.warnings };
}

// código curto da conta -> id da conta
const tagCache = { map: new Map(), at: 0 };
async function userIdByTag(tag) {
  if (tagCache.map.has(tag)) return tagCache.map.get(tag);
  if (Date.now() - tagCache.at < 30000) return null;
  tagCache.at = Date.now();
  const rows = await prisma.account.findMany({ select: { id: true } });
  for (const r of rows) tagCache.map.set(core.tagFor(r.id), r.id);
  return tagCache.map.get(tag) || null;
}

async function saveAudioFile(userId, id, wav, kind) {
  const tag = core.tagFor(userId);
  const dir = path.posix.join(host.dirs().sounds, tag);
  try {
    await host.writeFile(path.posix.join(dir, `${id}.wav`), wav, { mkdir: true });
    if (kind === 'moh') await host.writeFile(path.posix.join(dir, `moh-${id}`, `${id}.wav`), wav, { mkdir: true });
  } catch (e) {
    const err = new Error(`Não consegui gravar o áudio em ${dir} (${e.code || e.message}). Crie a pasta e dê permissão ao usuário do sistema (veja o guia).`);
    err.status = 502;
    throw err;
  }
}

async function removeAudioFile(userId, id) {
  const dir = path.posix.join(host.dirs().sounds, core.tagFor(userId));
  await host.rm(path.posix.join(dir, `${id}.wav`));
  await host.rm(path.posix.join(dir, `moh-${id}`), { recursive: true });
}

function audioFilePath(userId, id) {
  return path.posix.join(host.dirs().sounds, core.tagFor(userId), `${id}.wav`);
}

/** Gravação (ou recado) só é entregue se o nome tiver o código da conta (nada de caminhos soltos). */
function recordingPath(userId, file) {
  const tag = core.tagFor(userId);
  if (!/^[a-z0-9]{4}-(vm-)?[0-9.]+$/.test(file) && !/^ai-[0-9a-f-]{36}$/.test(file)) return null;
  if (!file.startsWith(`${tag}-`) && !file.startsWith('ai-')) return null;
  return path.posix.join(host.dirs().rec, `${file}.wav`);
}

module.exports = { loadPbxConfig, applyConfig, userIdByTag, saveAudioFile, removeAudioFile, audioFilePath, recordingPath, _tagCache: tagCache };
