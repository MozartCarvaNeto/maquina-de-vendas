// backend/src/services/whatsapp/nativeWhatsappService.js
require('./patchWwebjs'); // precisa vir ANTES do whatsapp-web.js (corrige envio de mídia)
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const prisma = require('../../config/db');
const env = require('../../config/env');
const chatMediaService = require('./chatMediaService');

// Quando o WhatsApp está publicando uma versão nova do Web, a página recarrega
// sozinha e a inicialização falha por alguns minutos. Mais tentativas, com
// espera crescente, deixam o sistema se recuperar sem intervenção.
const MAX_AUTO_RETRIES = 8;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000, 180000, 300000, 300000];

// O QR pode ser renovado várias vezes. O watchdog só dispara quando não há
// nenhum sinal de progresso dentro da janela.
const INIT_TIMEOUT_MS = 120000;
const QR_SCAN_WINDOW_MS = 90000;
const READY_AFTER_AUTH_MS = 120000;

// Teto absoluto apenas enquanto a sessão ainda NÃO foi autenticada.
// Depois de authenticated o teto é cancelado: a janela de ready passa a ser
// controlada exclusivamente por READY_AFTER_AUTH_MS.
const HARD_CEILING_MS = 10 * 60 * 1000;

// Monitor de saúde: detecta sessões "mortas" (Chromium travado, PC que
// dormiu, página crashada) que NÃO disparam o evento 'disconnected'.
const HEALTH_INTERVAL_MS = 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 20 * 1000;
const HEALTH_MAX_MISSES = 3;

// Tempo máximo para consultar/resolver um número (getNumberId) antes de enviar.
const RESOLVE_TIMEOUT_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const NO_LID_REGEX = /no lid for user/i;
const DEAD_PAGE_REGEX = /session closed|target closed|protocol error|execution context|browser has disconnected|page crashed/i;
const CONNECTION_ERROR_REGEX = /session closed|target closed|protocol error|disconnected|execution context|not connected|navigation|page crashed/i;

class NativeWhatsappService {
  constructor() {
    this.clients = new Map();
    this.initializing = new Set();
    this.retryCounts = new Map();
    this.retryTimers = new Map();
    this.watchdogTimers = new Map();
    this.hardCeilingTimers = new Map();
    this.authenticatedFlags = new Map();
    this.readyFlags = new Map();

    // Impede que logout/destroy/initialize concorram na mesma sessão.
    this.destroying = new Set();

    // Cada initialize() recebe uma geração. Eventos atrasados de uma sessão
    // antiga nunca podem destruir ou alterar o estado de uma sessão nova.
    this.generations = new Map();

    // Novos controles (estabilidade)
    this.qrFlags = new Map();       // true = o WhatsApp pediu QR (sessão em disco inválida)
    this.owners = new Map();        // connectionId -> userId
    this.healthMisses = new Map();  // falhas consecutivas do monitor de saúde
    this.healthTimer = null;
    this.healthRunning = false;
    this.shuttingDown = false;
  }

  isReady(connectionId) {
    return !!this.clients.get(connectionId) && !!this.readyFlags.get(connectionId) && !this.destroying.has(connectionId);
  }

  sessionDirOf(connectionId) {
    return path.join(this.getSessionsRoot(), `session-${connectionId}`);
  }

  /**
   * Mata processos Chromium "órfãos" que ainda seguram o perfil desta sessão
   * (acontece quando o Node é fechado à força no Windows). Sem isso, a
   * próxima inicialização trava/corrompe a sessão e o QR é pedido de novo.
   */
  killOrphanBrowsers(connectionId) {
    return new Promise((resolve) => {
      const marker = `session-${connectionId}`; // só ASCII (UUID): seguro p/ filtro
      const done = () => resolve();
      try {
        if (process.platform === 'win32') {
          const script =
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' -and $_.CommandLine -like '*" +
            marker +
            "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
          execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 15000, windowsHide: true },
            done
          );
        } else {
          execFile('pkill', ['-f', marker], { timeout: 10000 }, done);
        }
      } catch {
        done();
      }
    });
  }

  /** Remove travas de perfil deixadas por um Chromium que morreu sem fechar. */
  clearStaleLocks(connectionId) {
    const dir = this.sessionDirOf(connectionId);
    for (const name of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // ignora: ainda em uso ou inexistente
      }
    }
  }

  getSessionsRoot() {
    return path.join(__dirname, '../../../sessions');
  }

  nextGeneration(connectionId) {
    const generation = (this.generations.get(connectionId) || 0) + 1;
    this.generations.set(connectionId, generation);
    return generation;
  }

  isCurrent(connectionId, client, generation) {
    return this.generations.get(connectionId) === generation && this.clients.get(connectionId) === client;
  }

  async clearSessionFiles(connectionId, { attempts = 15, waitMs = 1000 } = {}) {
    const sessionDir = path.join(this.getSessionsRoot(), `session-${connectionId}`);

    if (!fs.existsSync(sessionDir)) return true;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`🧹 Sessão em disco removida: ${sessionDir}`);
        return true;
      } catch (err) {
        const message = String(err?.message || err);
        const busy = err?.code === 'EBUSY' || err?.code === 'EPERM' || /resource busy|locked/i.test(message);

        if (!busy || attempt === attempts) {
          console.error(`❌ Não foi possível limpar a sessão ${connectionId}:`, message);
          return false;
        }

        console.warn(`⏳ Sessão ${connectionId} ainda está bloqueada. Tentativa ${attempt}/${attempts}...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    return false;
  }

  async shutdownClient(connectionId, client, { clearFiles = false, keepRetryCount = false } = {}) {
    if (!client && !this.clients.has(connectionId)) {
      if (clearFiles) return this.clearSessionFiles(connectionId);
      return true;
    }

    if (this.destroying.has(connectionId)) {
      // Outro caminho já está encerrando esta sessão. Não inicie um segundo destroy().
      for (let i = 0; i < 20 && this.destroying.has(connectionId); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (clearFiles) return this.clearSessionFiles(connectionId);
      return !this.destroying.has(connectionId);
    }

    this.destroying.add(connectionId);

    // Invalida imediatamente eventos atrasados do Client antigo.
    this.nextGeneration(connectionId);
    this.clearTimers(connectionId);
    // Antes este contador era sempre zerado aqui, o que anulava o backoff e o
    // limite de tentativas. Agora só zera quando o encerramento é intencional.
    if (!keepRetryCount) this.retryCounts.delete(connectionId);
    this.initializing.delete(connectionId);
    this.authenticatedFlags.delete(connectionId);
    this.readyFlags.delete(connectionId);
    this.qrFlags.delete(connectionId);
    this.healthMisses.delete(connectionId);

    const currentClient = this.clients.get(connectionId);
    if (currentClient === client || !client) {
      this.clients.delete(connectionId);
    }

    try {
      if (client) {
        await Promise.race([
          client.destroy().catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 30000))
        ]);
      }
    } finally {
      // Garante que nenhum Chromium fique vivo segurando o perfil.
      try {
        const proc = client?.pupBrowser?.process?.();
        if (proc && !proc.killed) proc.kill('SIGKILL');
      } catch {
        // já encerrado
      }
      await this.killOrphanBrowsers(connectionId);

      // O destroy() do whatsapp-web.js pode retornar antes de o Chromium
      // liberar completamente os arquivos do perfil no Windows.
      if (clearFiles) {
        await this.clearSessionFiles(connectionId);
      }
      this.destroying.delete(connectionId);
    }

    return !clearFiles || !fs.existsSync(path.join(this.getSessionsRoot(), `session-${connectionId}`));
  }

  emitStatus(userId, connectionId, status, extra = {}) {
    const io = global.socketIoInstance;
    if (io) io.to(`user:${userId}`).emit('whatsapp:status', { connectionId, status, ...extra });
  }

  emitQr(userId, connectionId, qr) {
    const io = global.socketIoInstance;
    if (io) io.to(`user:${userId}`).emit('whatsapp:qr', { connectionId, qr });
  }

  async setStatus(connectionId, status) {
    await prisma.whatsappConnection
      .update({ where: { id: connectionId }, data: { status } })
      .catch(() => null);
  }

  clearWatchdog(connectionId) {
    const timer = this.watchdogTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.watchdogTimers.delete(connectionId);
  }

  clearHardCeiling(connectionId) {
    const timer = this.hardCeilingTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.hardCeilingTimers.delete(connectionId);
  }

  clearRetryTimer(connectionId) {
    const timer = this.retryTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(connectionId);
  }

  clearTimers(connectionId) {
    this.clearWatchdog(connectionId);
    this.clearHardCeiling(connectionId);
    this.clearRetryTimer(connectionId);
  }

  armWatchdog(connectionId, userId, ms, client, generation) {
    this.clearWatchdog(connectionId);
    const timer = setTimeout(() => {
      this.watchdogTimers.delete(connectionId);
      if (!this.isCurrent(connectionId, client, generation)) return;
      this.handleSessionFailure(
        connectionId,
        userId,
        `sem progresso por ${Math.round(ms / 1000)}s`,
        { client, generation }
      ).catch((err) => console.error(`Erro no watchdog ${connectionId}:`, err.message));
    }, ms);
    this.watchdogTimers.set(connectionId, timer);
  }

  async scheduleReconnect(connectionId, userId, { forceNew = false, reason = 'desconexão' } = {}) {
    if (
      this.shuttingDown ||
      this.retryTimers.has(connectionId) ||
      this.initializing.has(connectionId) ||
      this.clients.has(connectionId) ||
      this.destroying.has(connectionId)
    ) {
      return;
    }

    const attempts = this.retryCounts.get(connectionId) || 0;
    if (attempts >= MAX_AUTO_RETRIES) {
      this.retryCounts.delete(connectionId);
      await this.setStatus(connectionId, forceNew ? 'erro' : 'desconectado');
      this.emitStatus(userId, connectionId, forceNew ? 'erro' : 'desconectado', {
        reason,
        message: forceNew
          ? 'A sessão precisa de um novo QR. Clique em "Gerar novo QR".'
          : 'WhatsApp desconectado. Clique em "Gerar novo QR" se a reconexão automática não ocorrer.'
      });
      return;
    }

    const delay = RETRY_DELAYS_MS[attempts] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    this.retryCounts.set(connectionId, attempts + 1);
    await this.setStatus(connectionId, 'pendente');
    this.emitStatus(userId, connectionId, 'pendente', {
      reason,
      message: `Reconectando automaticamente em ${Math.ceil(delay / 1000)}s (tentativa ${attempts + 1}/${MAX_AUTO_RETRIES})...`
    });

    const timer = setTimeout(() => {
      this.retryTimers.delete(connectionId);
      this.initSession({ id: connectionId, userId, forceNew }).catch((err) =>
        console.error(`Erro na autorretentativa ${connectionId}:`, err.message)
      );
    }, delay);
    this.retryTimers.set(connectionId, timer);
  }

  async handleSessionFailure(connectionId, userId, reason, context = {}) {
    const { client: expectedClient = null, generation: expectedGeneration = null } = context;
    const currentClient = this.clients.get(connectionId);
    const currentGeneration = this.generations.get(connectionId);

    if (expectedClient && currentClient !== expectedClient) return;
    if (expectedGeneration && currentGeneration !== expectedGeneration) return;

    console.error(`❌ [${connectionId}] Falha de sessão WhatsApp (${reason})`);

    const client = currentClient;
    const wasAuthenticated = this.authenticatedFlags.get(connectionId) || false;
    const qrWasRequested = this.qrFlags.get(connectionId) || false;

    // Nunca apague o perfil aqui. Primeiro encerre o Chromium e aguarde os
    // arquivos serem liberados. Preserva o contador de tentativas (backoff).
    await this.shutdownClient(connectionId, client, { clearFiles: false, keepRetryCount: true });

    // CORREÇÃO IMPORTANTE: antes, qualquer falha ANTES do evento 'authenticated'
    // (por ex. Chromium lento demais para carregar) apagava a sessão salva e
    // obrigava a ler o QR de novo. Agora só exigimos novo QR quando o próprio
    // WhatsApp pediu QR (sessão realmente inválida) ou houve auth_failure.
    const forceNew = /auth_failure/i.test(String(reason)) || (qrWasRequested && !wasAuthenticated);
    await this.scheduleReconnect(connectionId, userId, { forceNew, reason });
  }

  async initSession({ id: connectionId, userId, forceNew = false }) {
    if (this.shuttingDown) return null;

    if (this.destroying.has(connectionId)) {
      console.log(`⏳ Sessão ${connectionId} ainda está sendo encerrada. Nova inicialização aguardará.`);
      return null;
    }

    // Conta vencida/bloqueada: não abre navegador nenhum para ela.
    if (await require('../accessService').isAccountBlocked(userId)) {
      console.log(`⛔ Sessão ${connectionId} não iniciada: conta ${userId} sem acesso ativo.`);
      return null;
    }

    // Plano sem o módulo de Conexões de WhatsApp: não abre navegador.
    if (!(await require('../featureService').accountHasFeature(userId, 'conexoes'))) {
      console.log(`⛔ Sessão ${connectionId} não iniciada: o plano da conta ${userId} não inclui WhatsApp.`);
      return null;
    }

    if (this.clients.has(connectionId)) return this.clients.get(connectionId);
    if (this.initializing.has(connectionId)) {
      console.log(`⏳ Sessão ${connectionId} já está inicializando, aguarde...`);
      return null;
    }

    this.initializing.add(connectionId);
    this.owners.set(connectionId, userId);
    this.clearTimers(connectionId);
    this.authenticatedFlags.delete(connectionId);
    this.readyFlags.delete(connectionId);
    this.qrFlags.delete(connectionId);
    this.healthMisses.delete(connectionId);
    this.clearRetryTimer(connectionId);

    // Libera qualquer Chromium órfão que ainda segure o perfil desta sessão.
    await this.killOrphanBrowsers(connectionId);

    if (forceNew) {
      const cleaned = await this.clearSessionFiles(connectionId);
      if (!cleaned) {
        this.initializing.delete(connectionId);
        await this.setStatus(connectionId, 'erro');
        this.emitStatus(userId, connectionId, 'erro', {
          message: 'Não foi possível liberar os arquivos da sessão anterior. O navegador ainda pode estar encerrando; tente gerar o QR novamente em alguns segundos.'
        });
        return null;
      }
    }

    // Sessão preservada: remove travas deixadas por um encerramento brusco.
    if (!forceNew) this.clearStaleLocks(connectionId);

    const generation = this.nextGeneration(connectionId);

    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled',
        // Evita que o Chromium "congele" a página do WhatsApp Web quando o
        // computador fica ocioso/minimizado (causa comum de quedas silenciosas).
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    };

    const clientOptions = {
      authStrategy: new LocalAuth({
        clientId: connectionId,
        dataPath: this.getSessionsRoot()
      }),
      // Evita que a própria lib reinicie o mesmo client em paralelo ao nosso
      // mecanismo de reconexão.
      restartOnAuthFail: false,
      takeoverOnConflict: true,
      puppeteer: puppeteerOptions
    };

    // Versão do WhatsApp Web fixada (opcional): evita que a página recarregue
    // no meio da inicialização quando o WhatsApp publica uma versão nova.
    //  - Só WHATSAPP_WEB_VERSION definida  -> usa o arquivo salvo em .wwebjs_cache
    //  - + WHATSAPP_WEB_VERSION_CACHE_URL  -> baixa o HTML dessa versão da URL
    if (env.whatsappWebVersion) {
      clientOptions.webVersion = env.whatsappWebVersion;
      if (env.whatsappWebVersionCacheUrl) {
        clientOptions.webVersionCache = {
          type: 'remote',
          remotePath: env.whatsappWebVersionCacheUrl,
          strict: false
        };
      } else {
        clientOptions.webVersionCache = {
          type: 'local',
          path: path.join(__dirname, '../../../.wwebjs_cache/'),
          strict: false
        };
        const cacheFile = path.join(__dirname, '../../../.wwebjs_cache', `${env.whatsappWebVersion}.html`);
        if (!fs.existsSync(cacheFile)) {
          console.warn(
            `⚠️ WHATSAPP_WEB_VERSION=${env.whatsappWebVersion} não existe em .wwebjs_cache — será usada a versão mais recente.`
          );
        }
      }
      console.log(`📌 [${connectionId}] WhatsApp Web fixado em ${env.whatsappWebVersion}`);
    }

    const client = new Client(clientOptions);
    this.clients.set(connectionId, client);

    client.on('qr', async (qr) => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      console.log(`📱 QR RECEBIDO para conexão ${connectionId}`);
      this.qrFlags.set(connectionId, true);
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320 });
        if (!this.isCurrent(connectionId, client, generation)) return;
        await this.setStatus(connectionId, 'pendente');
        this.emitStatus(userId, connectionId, 'pendente');
        this.emitQr(userId, connectionId, qrDataUrl);
        this.armWatchdog(connectionId, userId, QR_SCAN_WINDOW_MS, client, generation);
        console.log(`📤 QR emitido via socket para user:${userId}`);
      } catch (error) {
        console.error(`Erro ao gerar QR Code da conexão ${connectionId}:`, error.message);
      }
    });

    client.on('loading_screen', (percent, message) => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      console.log(`⏳ [${connectionId}] Carregando WhatsApp Web: ${percent}% — ${message}`);
      this.armWatchdog(connectionId, userId, INIT_TIMEOUT_MS, client, generation);
    });

    client.on('change_state', (state) => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      console.log(`🔄 [${connectionId}] Estado: ${state}`);
      if (state === 'CONNECTED' && this.authenticatedFlags.get(connectionId)) {
        // Não substitui o ready; apenas registra atividade para não disparar
        // o watchdog durante uma navegação normal do WhatsApp Web.
        this.armWatchdog(connectionId, userId, READY_AFTER_AUTH_MS, client, generation);
      }
    });

    client.on('authenticated', () => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      if (this.authenticatedFlags.get(connectionId)) return;

      console.log(`🔐 [${connectionId}] Autenticado! Aguardando 'ready'...`);
      this.authenticatedFlags.set(connectionId, true);
      this.qrFlags.delete(connectionId);
      this.clearHardCeiling(connectionId);
      this.armWatchdog(connectionId, userId, READY_AFTER_AUTH_MS, client, generation);
      this.emitStatus(userId, connectionId, 'pendente', {
        message: 'Autenticado! Finalizando conexão...'
      });
    });

    client.on('ready', async () => {
      if (!this.isCurrent(connectionId, client, generation)) return;

      this.clearTimers(connectionId);
      this.retryCounts.delete(connectionId);
      this.authenticatedFlags.delete(connectionId);
      this.readyFlags.set(connectionId, true);
      this.qrFlags.delete(connectionId);
      this.healthMisses.delete(connectionId);

      // Se a página/navegador morrer sem avisar, recuperamos na hora em vez de
      // esperar o disparo falhar.
      try {
        const onGone = (why) => {
          if (!this.isCurrent(connectionId, client, generation)) return;
          if (this.destroying.has(connectionId) || this.shuttingDown) return;
          console.error(`❌ [${connectionId}] ${why}`);
          this.handleSessionFailure(connectionId, userId, why, { client, generation }).catch((err) =>
            console.error(`Erro recuperando sessão ${connectionId}:`, err.message)
          );
        };
        client.pupPage?.on('close', () => onGone('página do WhatsApp Web foi fechada'));
        client.pupPage?.on('error', () => onGone('página do WhatsApp Web travou (crash)'));
        client.pupBrowser?.on('disconnected', () => onGone('navegador (Chromium) encerrou'));
      } catch (err) {
        console.warn(`⚠️ [${connectionId}] Não foi possível monitorar a página:`, err.message);
      }

      const phone = client.info?.wid?.user || null;
      await prisma.whatsappConnection
        .update({ where: { id: connectionId }, data: { status: 'conectado', phone } })
        .catch(() => null);

      this.emitStatus(userId, connectionId, 'conectado', { phone });
      console.log(`✅ WhatsApp conectado: ${connectionId} (${phone})`);
    });

    client.on('auth_failure', async (message) => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      console.error(`❌ Falha de autenticação WhatsApp ${connectionId}:`, message);
      this.authenticatedFlags.delete(connectionId);
      this.clearTimers(connectionId);
      await this.handleSessionFailure(connectionId, userId, `auth_failure: ${message}`, {
        client,
        generation
      });
    });

    client.on('disconnected', async (reason) => {
      if (!this.isCurrent(connectionId, client, generation)) return;

      console.log(`⚠️ WhatsApp desconectado: ${connectionId} (${reason})`);

      const normalized = String(reason || '').toUpperCase();
      const mustPairAgain = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'UNPAIRED_PHONE'].some((x) =>
        normalized.includes(x)
      );

      // IMPORTANTE: não remova a pasta enquanto o Chromium ainda está vivo.
      // O antigo código fazia clearSessionFiles() diretamente neste evento,
      // causando EBUSY no Windows e deixando o profile.lock ativo.
      await this.shutdownClient(connectionId, client, { clearFiles: mustPairAgain, keepRetryCount: !mustPairAgain });

      if (mustPairAgain) {
        this.retryCounts.delete(connectionId);

        const sessionDir = path.join(this.getSessionsRoot(), `session-${connectionId}`);
        const cleaned = !fs.existsSync(sessionDir);

        await this.setStatus(connectionId, cleaned ? 'erro' : 'pendente');
        this.emitStatus(userId, connectionId, cleaned ? 'erro' : 'pendente', {
          reason,
          message: cleaned
            ? 'O WhatsApp encerrou a sessão. Gere um novo QR para conectar novamente.'
            : 'O navegador ainda está liberando a sessão anterior. Aguarde alguns segundos e gere um novo QR.'
        });
        return;
      }

      await this.setStatus(connectionId, 'desconectado');
      this.emitStatus(userId, connectionId, 'desconectado', {
        reason,
        message: 'Conexão perdida. Tentando reconectar automaticamente...'
      });

      await this.scheduleReconnect(connectionId, userId, {
        forceNew: false,
        reason: `desconectado: ${reason}`
      });
    });

    client.on('message', async (message) => {
      if (!this.isCurrent(connectionId, client, generation)) return;
      await this.handleIncomingMessage(userId, connectionId, message).catch((err) =>
        console.error('Erro ao processar mensagem recebida:', err.message)
      );
    });

    this.armWatchdog(connectionId, userId, INIT_TIMEOUT_MS, client, generation);

    const hardCeiling = setTimeout(() => {
      this.hardCeilingTimers.delete(connectionId);
      if (!this.isCurrent(connectionId, client, generation)) return;
      if (this.authenticatedFlags.get(connectionId) || this.readyFlags.get(connectionId)) return;
      this.handleSessionFailure(
        connectionId,
        userId,
        `teto de segurança de ${HARD_CEILING_MS / 1000}s atingido`,
        { client, generation }
      ).catch((err) => console.error(`Erro no teto de segurança ${connectionId}:`, err.message));
    }, HARD_CEILING_MS);
    this.hardCeilingTimers.set(connectionId, hardCeiling);

    client
      .initialize()
      .then(() => console.log(`🚀 [${connectionId}] initialize() concluído`))
      .catch((error) => {
        if (!this.isCurrent(connectionId, client, generation)) return;
        console.error(`Erro ao inicializar sessão WhatsApp ${connectionId}:`, error.message);
        this.handleSessionFailure(connectionId, userId, `initialize() rejeitou: ${error.message}`, {
          client,
          generation
        }).catch((err) => console.error(`Erro tratando initialize ${connectionId}:`, err.message));
      })
      .finally(() => {
        if (this.generations.get(connectionId) === generation) this.initializing.delete(connectionId);
      });

    return client;
  }

  /**
   * Desde a migração para LID, mensagens recebidas podem vir de "123@lid" em
   * vez de "5511...@c.us". Aqui convertemos para o número de telefone real.
   */
  async resolveIncomingPhone(connectionId, message) {
    const from = String(message.from || '');

    if (from.endsWith('@c.us')) return from.replace('@c.us', '');
    if (!from.endsWith('@lid')) return from.replace(/@.*$/, '') || null;

    const client = this.clients.get(connectionId);

    try {
      if (client) {
        const [info] = (await client.getContactLidAndPhone([from])) || [];
        if (info?.pn) return String(info.pn).replace(/@.*$/, '');
      }
    } catch {
      // tenta o próximo método
    }

    try {
      const contact = await message.getContact();
      const serialized = contact?.id?._serialized || '';
      if (serialized.endsWith('@c.us')) return serialized.replace('@c.us', '');
    } catch {
      // sem telefone resolvido
    }

    return null;
  }

  async handleIncomingMessage(userId, connectionId, message) {
    if (message.fromMe) return;
    const from = String(message.from || '');
    if (from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter')) return;

    const phone = await this.resolveIncomingPhone(connectionId, message);
    const text = message.body || '';

    // Foto, vídeo, áudio, documento ou figurinha: baixa e guarda o arquivo.
    // (Antes, mensagem sem texto era descartada — por isso o chat "não recebia" mídia.)
    let mediaFields = {};
    if (message.hasMedia) {
      try {
        const media = await withTimeout(message.downloadMedia(), 60000, 'download de mídia demorou demais');
        if (media?.data) {
          const buffer = Buffer.from(media.data, 'base64');
          if (buffer.length <= chatMediaService.MAX_RECEIVE_BYTES) {
            mediaFields = chatMediaService.saveBuffer(
              userId,
              buffer,
              media.mimetype,
              media.filename || (message.type === 'sticker' ? 'figurinha.webp' : null)
            );
          } else {
            console.warn(`⚠️ [${connectionId}] Mídia recebida muito grande (${buffer.length} bytes) — não salva.`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [${connectionId}] Não consegui baixar a mídia recebida: ${err.message}`);
      }
    }

    if (!text && !mediaFields.mediaPath) {
      // Mídia que não foi possível baixar: registra um aviso para a mensagem não "sumir".
      if (!message.hasMedia) return;
    }
    if (!phone) {
      console.warn(`⚠️ [${connectionId}] Mensagem recebida de ${from} sem telefone resolvido (LID) — ignorada.`);
      return;
    }

    let lead = await prisma.lead.findFirst({ where: { userId, phone: { contains: phone } } });

    if (!lead) {
      const contact = await message.getContact().catch(() => null);
      lead = await prisma.lead.create({
        data: {
          userId,
          name: contact?.pushname || contact?.name || phone,
          phone,
          consentSource: 'whatsapp_organico',
          status: 'novo'
        }
      });
    }

    const savedMessage = await prisma.message.create({
      data: {
        leadId: lead.id,
        direction: 'entrada',
        channel: 'whatsapp',
        body: text || (message.hasMedia && !mediaFields.mediaPath ? '[Anexo recebido, mas não foi possível baixar]' : ''),
        ...mediaFields
      }
    });

    const io = global.socketIoInstance;
    if (io) io.to(`user:${userId}`).emit('whatsapp:message', { leadId: lead.id, message: savedMessage });

    // Descobre a campanha/origem do lead e deixa o robô responder (se ativo).
    const ctx = message._data?.ctwaContext || message.rawData?.ctwaContext || null;
    const referral = ctx
      ? { sourceId: ctx.sourceId || ctx.source_id, sourceUrl: ctx.sourceUrl || ctx.source_url, headline: ctx.title || ctx.headline }
      : null;
    if (!text) return; // só mídia: o robô responde apenas a mensagens de texto
    await require('../campaignBotService').handleIncoming({
      userId,
      connectionId,
      lead,
      text,
      referral,
      sendReply: (replyText) => this.sendMessage(connectionId, lead.phone, replyText, null, { sendSeen: true })
    });
  }

  buildSendError(error, fallbackMessage = 'Falha ao enviar mensagem pelo WhatsApp.') {
    const raw = String(error?.message || error || '');
    const err = new Error(raw || fallbackMessage);
    err.status = error?.status || 502;
    err.isConnectionError = CONNECTION_ERROR_REGEX.test(raw);
    if (error?.code) err.code = error.code;
    return err;
  }

  /** Normaliza para o formato internacional (assume Brasil quando vier sem DDI). */
  normalizePhoneDigits(rawPhone) {
    let digits = String(rawPhone || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    // 10 ou 11 dígitos = DDD + número, sem o 55 do Brasil.
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
  }

  /**
   * Resolve o destino ANTES de enviar. É isto que corrige o erro
   * "No LID for user": o WhatsApp Web agora endereça usuários por LID, e o
   * envio falha se o mapeamento telefone -> LID ainda não existe no navegador.
   * getNumberId() consulta o servidor (e trata o 9º dígito do Brasil) e
   * getContactLidAndPhone() força o WhatsApp Web a registrar o LID.
   */
  async resolveTarget(client, digits) {
    let numberId;
    try {
      numberId = await withTimeout(
        client.getNumberId(digits),
        RESOLVE_TIMEOUT_MS,
        'Tempo esgotado ao consultar o número no WhatsApp.'
      );
    } catch (error) {
      throw this.buildSendError(error, 'Não foi possível consultar o número no WhatsApp.');
    }

    if (!numberId) {
      const err = new Error('Este número não possui WhatsApp.');
      err.status = 422;
      err.code = 'NOT_ON_WHATSAPP';
      err.isConnectionError = false;
      throw err;
    }

    const pnId = numberId._serialized || `${numberId.user}@${numberId.server}`;
    let lidId = numberId.server === 'lid' ? pnId : null;

    try {
      const [info] = (await withTimeout(client.getContactLidAndPhone([pnId]), 15000, 'lid timeout')) || [];
      if (info?.lid) lidId = info.lid;
    } catch {
      // Não é fatal: o envio ainda pode funcionar sem o LID explícito.
    }

    return { pnId, lidId };
  }

  async sendMessage(connectionId, toPhone, text, mediaFilePath = null, options = {}) {
    const client = this.clients.get(connectionId);
    const ready = this.readyFlags.get(connectionId);

    if (!client || !ready) {
      const err = new Error(
        'Esta conexão de WhatsApp não está pronta para envio. Verifique em Conexões e aguarde o status CONECTADO.'
      );
      err.status = 409;
      err.isConnectionError = true;
      throw err;
    }

    let state = null;
    try {
      state = await withTimeout(client.getState(), HEALTH_CHECK_TIMEOUT_MS, 'getState timeout');
    } catch (error) {
      this.healthMisses.set(connectionId, HEALTH_MAX_MISSES - 1); // acelera a recuperação
      const err = new Error(`Sessão WhatsApp indisponível: ${error.message}`);
      err.status = 409;
      err.isConnectionError = true;
      throw err;
    }

    if (state !== 'CONNECTED') {
      const err = new Error(`Sessão WhatsApp não está conectada (estado: ${state || 'desconhecido'}).`);
      err.status = 409;
      err.isConnectionError = true;
      throw err;
    }

    const digits = this.normalizePhoneDigits(toPhone);
    if (!digits) {
      const err = new Error('Telefone do lead inválido ou vazio.');
      err.status = 400;
      throw err;
    }

    if (mediaFilePath && !fs.existsSync(mediaFilePath)) {
      const err = new Error('Arquivo anexado não encontrado no servidor.');
      err.status = 500;
      throw err;
    }

    const sendOptions = { sendSeen: options.sendSeen === true };

    const sendTo = async (chatId) => {
      if (mediaFilePath) {
        const media = options.mediaMime
          ? new MessageMedia(
              options.mediaMime,
              fs.readFileSync(mediaFilePath).toString('base64'),
              options.mediaName || path.basename(mediaFilePath)
            )
          : MessageMedia.fromFilePath(mediaFilePath);
        const mediaSendOptions = { ...sendOptions, caption: text || '' };
        // Documentos (PDF, Word, Excel...) precisam ir como arquivo, não como foto.
        if (options.asDocument) mediaSendOptions.sendMediaAsDocument = true;
        return client.sendMessage(chatId, media, mediaSendOptions);
      }
      return client.sendMessage(chatId, text || '', sendOptions);
    };

    const { pnId, lidId } = await this.resolveTarget(client, digits);

    try {
      return await sendTo(pnId);
    } catch (firstError) {
      const firstMessage = String(firstError?.message || firstError || '');

      if (!NO_LID_REGEX.test(firstMessage)) {
        if (DEAD_PAGE_REGEX.test(firstMessage)) this.healthMisses.set(connectionId, HEALTH_MAX_MISSES - 1);
        throw this.buildSendError(firstError);
      }

      // --- Recuperação do erro "No LID for user" ---
      console.warn(`⚠️ [${connectionId}] "No LID" ao enviar para ${digits}. Forçando resolução do LID e tentando de novo...`);

      // 1) reforça o mapeamento e tenta o número normal mais uma vez
      let refreshedLid = lidId;
      try {
        await sleep(1500);
        await client.getNumberId(digits);
        const [info] = (await client.getContactLidAndPhone([pnId])) || [];
        if (info?.lid) refreshedLid = info.lid;
        await sleep(1000);
        return await sendTo(pnId);
      } catch (secondError) {
        const secondMessage = String(secondError?.message || secondError || '');
        if (!NO_LID_REGEX.test(secondMessage)) throw this.buildSendError(secondError);
      }

      // 2) envia direto para o LID, quando conhecido
      if (refreshedLid && refreshedLid !== pnId) {
        try {
          return await sendTo(refreshedLid);
        } catch (thirdError) {
          throw this.buildSendError(thirdError);
        }
      }

      const err = new Error(
        'O WhatsApp não conseguiu resolver o identificador (LID) deste contato. Tente novamente mais tarde.'
      );
      err.status = 502;
      err.code = 'NO_LID';
      err.isConnectionError = false;
      throw err;
    }
  }

  async getStatus(connectionId) {
    const client = this.clients.get(connectionId);
    if (!client || !this.readyFlags.get(connectionId)) return 'desconectado';
    try {
      const state = await client.getState();
      return state === 'CONNECTED' ? 'conectado' : 'desconectado';
    } catch {
      return 'desconectado';
    }
  }

  async destroySession(connectionId) {
    this.clearTimers(connectionId);
    this.retryCounts.delete(connectionId);

    const client = this.clients.get(connectionId);
    await this.shutdownClient(connectionId, client, { clearFiles: true });
  }

  async bootstrapExistingSessions() {
    this.startHealthMonitor();

    const all = await prisma.whatsappConnection.findMany({ orderBy: { createdAt: 'asc' } });

    // Restaura toda conexão que ainda tenha sessão salva em disco (mesmo que o
    // status esteja "desconectado"/"erro" por uma queda anterior) e as que
    // estavam ativas/pendentes.
    const connections = all.filter(
      (conn) =>
        ['conectado', 'pendente', 'desconectado'].includes(conn.status) ||
        fs.existsSync(this.sessionDirOf(conn.id))
    );

    if (connections.length === 0) {
      console.log('ℹ️ Nenhuma sessão de WhatsApp para restaurar.');
      return;
    }

    console.log(`🔄 Restaurando ${connections.length} sessão(ões) de WhatsApp...`);
    for (const conn of connections) {
      await this.initSession({ id: conn.id, userId: conn.userId }).catch((err) =>
        console.error(`Falha ao restaurar sessão ${conn.id}:`, err.message)
      );

      // Sobe UMA sessão por vez: espera ficar pronta, pedir QR ou falhar (até
      // 2,5 min) antes de abrir o próximo Chromium. Abrir vários juntos deixa
      // a inicialização lenta e mais sujeita a falhar.
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        if (this.readyFlags.get(conn.id) || this.qrFlags.get(conn.id) || !this.clients.has(conn.id)) break;
        await sleep(1000);
      }
      await sleep(2000);
    }
  }

  // ==================== MONITOR DE SAÚDE ====================

  startHealthMonitor() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => console.error('Erro no monitor de saúde do WhatsApp:', err.message));
    }, HEALTH_INTERVAL_MS);
    console.log('✅ Monitor de saúde do WhatsApp ativo (1 min)');
  }

  async runHealthCheck() {
    if (this.healthRunning || this.shuttingDown) return;
    this.healthRunning = true;

    try {
      for (const [connectionId, client] of Array.from(this.clients.entries())) {
        if (!this.readyFlags.get(connectionId) || this.destroying.has(connectionId)) continue;

        const generation = this.generations.get(connectionId);
        const userId = this.owners.get(connectionId);
        let state = null;

        try {
          state = await withTimeout(client.getState(), HEALTH_CHECK_TIMEOUT_MS, 'getState timeout');
        } catch (error) {
          state = `erro: ${error.message}`;
        }

        if (state === 'CONNECTED') {
          this.healthMisses.delete(connectionId);
          continue;
        }

        const misses = (this.healthMisses.get(connectionId) || 0) + 1;
        this.healthMisses.set(connectionId, misses);
        console.warn(`⚠️ [${connectionId}] Monitor de saúde: estado "${state}" (${misses}/${HEALTH_MAX_MISSES})`);

        if (misses >= HEALTH_MAX_MISSES && userId) {
          this.healthMisses.delete(connectionId);
          await this.handleSessionFailure(connectionId, userId, `monitor de saúde: estado "${state}"`, {
            client,
            generation
          }).catch((err) => console.error(`Erro recuperando sessão ${connectionId}:`, err.message));
        }
      }
    } finally {
      this.healthRunning = false;
    }
  }

  // ==================== ENCERRAMENTO SEGURO ====================

  /**
   * Fecha todos os navegadores com segurança ao encerrar o servidor (Ctrl+C,
   * fechar a janela do terminal, etc.). Preserva os arquivos de sessão, então
   * na próxima inicialização NÃO é preciso ler o QR de novo.
   */
  async shutdownAll({ timeoutMs = 8000 } = {}) {
    this.shuttingDown = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;

    const entries = Array.from(this.clients.entries());
    for (const [id] of entries) this.clearTimers(id);

    await Promise.race([
      Promise.all(entries.map(([id, client]) => this.shutdownClient(id, client, { clearFiles: false }).catch(() => null))),
      sleep(timeoutMs)
    ]);

    // Último recurso: derruba qualquer Chromium que tenha sobrado.
    await Promise.race([
      Promise.all(entries.map(([id]) => this.killOrphanBrowsers(id))),
      sleep(4000)
    ]);
  }
}

module.exports = new NativeWhatsappService();