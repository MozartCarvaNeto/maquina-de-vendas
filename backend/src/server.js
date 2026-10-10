// backend/src/server.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const env = require('./config/env');
const { initSocket } = require('./socket');
const errorHandler = require('./middlewares/errorHandler');

const authRoutes = require('./routes/auth.routes');
const teamRoutes = require('./routes/team.routes');
const settingsRoutes = require('./routes/settings.routes');
const aiSettingsRoutes = require('./routes/aiSettings.routes');
const campaignsRoutes = require('./routes/campaigns.routes');
const leadsRoutes = require('./routes/leads.routes');
const leadListsRoutes = require('./routes/leadLists.routes');
const crmRoutes = require('./routes/crm.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const whatsappCloudRoutes = require('./routes/whatsappCloud.routes');
const callsRoutes = require('./routes/calls.routes');
const linesRoutes = require('./routes/lines.routes');
const broadcastsRoutes = require('./routes/broadcasts.routes');
const emailDomainsRoutes = require('./routes/emailDomains.routes');
const emailTrackingRoutes = require('./routes/emailTracking.routes');
const roboCallsRoutes = require('./routes/robocalls.routes');
const callQueueRoutes = require('./routes/callQueue.routes');
const { startRoboCallWatchdogJob } = require('./jobs/roboCallWatchdogJob');
const aiCallsRoutes = require('./routes/aiCalls.routes');
const { startAiCallWatchdogJob } = require('./jobs/aiCallWatchdogJob');

const { startFollowUpNurtureJob } = require('./jobs/followUpNurtureJob');
const { startBroadcastSchedulerJob } = require('./jobs/broadcastSchedulerJob');
const nativeWhatsappService = require('./services/whatsapp/nativeWhatsappService');
const adminRoutes = require('./routes/admin.routes');
const billingRoutes = require('./routes/billing.routes');
const billingController = require('./controllers/billingController');
const { startAccessSweepJob } = require('./jobs/accessSweepJob');
const { ensureAdminAccounts } = require('./services/accessService');

// Rede de segurança contra crashes vindos de bibliotecas de terceiros.
// Especificamente, a lib whatsapp-web.js tem um bug conhecido no Windows:
// ao receber um LOGOUT do celular, ela tenta limpar a sessão em disco
// internamente (fora do nosso código, então não dá pra usar try/catch) e
// às vezes esbarra num arquivo do Chromium ainda "travado"
// (EBUSY: resource busy or locked). Essa promise rejeitada não tratada
// derrubava o processo Node inteiro (disparos, discador, CRM, tudo).
// Aqui só logamos o erro e mantemos o backend no ar.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection (processo mantido no ar):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception (processo mantido no ar):', err);
});

const app = express();
// Atrás do Nginx/Caddy: enxerga o IP real da pessoa (necessário para o limite de tentativas).
app.set('trust proxy', env.trustProxy);
const server = http.createServer(app);

app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(
  express.json({
    limit: '2mb',
    // Guarda o corpo "cru" da requisição — só é usado pelo webhook da Meta,
    // pra confirmar (por assinatura) que a chamada é mesmo da Meta. Não
    // muda nada no comportamento normal do req.body em nenhuma outra rota.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(express.urlencoded({ extended: true }));

const io = initSocket(server, env.frontendUrl);
app.set('io', io);
global.socketIoInstance = io;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'maquina-de-vendas-backend' });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
// Públicas (sem login): configurações da tela de entrada e aviso de pagamento do Asaas.
app.get('/api/public/config', billingController.publicConfig);
app.post('/api/webhooks/asaas', billingController.asaasWebhook);
app.use('/api/team', teamRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/settings/ai', aiSettingsRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/lead-lists', leadListsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/whatsapp-cloud', whatsappCloudRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/lines', linesRoutes);
app.use('/api/broadcasts', broadcastsRoutes);
app.use('/api/email-domains', emailDomainsRoutes);
app.use('/api/robocalls', roboCallsRoutes);
app.use('/api/ai-calls', aiCallsRoutes);
app.use('/api/call-queue', callQueueRoutes);
// Rotas públicas (sem login) de abertura/clique/descadastro de e-mail —
// precisam ficar acessíveis pelo cliente de e-mail do destinatário.
app.use('/api/email/t', emailTrackingRoutes);

// Serve as imagens anexadas aos disparos (usadas para pré-visualização na
// tela de Disparos e como fonte dos anexos enviados por e-mail/WhatsApp).
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

/**
 * Se o frontend já foi compilado (npm run build gerou frontend/dist), o
 * próprio backend serve esses arquivos. Isso permite rodar o sistema
 * inteiro com um único comando/processo — é a base do atalho de duplo
 * clique (veja "Iniciar Máquina de Vendas.bat" na raiz do projeto).
 */
const frontendDistPath = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
  console.log('🖥️  Servindo o frontend compilado (frontend/dist) — acesse tudo em um único endereço.');
}

app.use(errorHandler);

server.listen(env.port, async () => {
  console.log(`🚀 Backend Turbo Prospect rodando na porta ${env.port}`);
  console.log(`🔐 Cadastro público: modo "${env.registrationMode}"`);
  startFollowUpNurtureJob();
  startBroadcastSchedulerJob();
  startRoboCallWatchdogJob();
  startAiCallWatchdogJob();
  startAccessSweepJob();
  // Libera as contas dos administradores ANTES de restaurar as sessões de WhatsApp.
  await ensureAdminAccounts().catch((err) => console.error('Erro ao liberar administradores:', err.message));
  nativeWhatsappService.bootstrapExistingSessions();
});

/**
 * Encerramento seguro. Fechar a janela do terminal / Ctrl+C sem isso mata o
 * Node à força e deixa o Chromium do WhatsApp aberto ("órfão") segurando os
 * arquivos da sessão — na próxima inicialização o WhatsApp pede QR de novo.
 * Aqui fechamos os navegadores corretamente e preservamos a sessão salva.
 */
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} recebido — encerrando o WhatsApp com segurança...`);
  try {
    await nativeWhatsappService.shutdownAll({ timeoutMs: 8000 });
  } catch (err) {
    console.error('Erro ao encerrar o WhatsApp:', err.message);
  }
  server.close();
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGUSR2'].forEach((signal) => {
  try {
    process.on(signal, () => gracefulShutdown(signal));
  } catch {
    // sinal não suportado nesta plataforma
  }
});