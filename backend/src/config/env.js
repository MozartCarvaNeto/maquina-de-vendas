// backend/src/config/env.js
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

module.exports = {
  port: process.env.PORT || 3333,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  settingsEncryptionKey: required('SETTINGS_ENCRYPTION_KEY'),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || 'http://localhost:3333',

  // ---- Controle de acesso (venda do sistema) ----
  // E-mails (separados por vírgula) que são ADMINISTRADORES DA PLATAFORMA:
  // enxergam o painel /admin e nunca são bloqueados por assinatura.
  superAdminEmails: String(process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  // Como funciona o botão "Criar conta" da tela de login:
  //   approval = (padrão) a pessoa se cadastra, mas só entra depois que você aprovar
  //   closed   = cadastro público desligado (você cria as contas no painel)
  //   open     = libera na hora (com período de teste, se TRIAL_DAYS > 0)
  registrationMode: ['approval', 'closed', 'open'].includes(String(process.env.REGISTRATION_MODE || '').toLowerCase())
    ? String(process.env.REGISTRATION_MODE).toLowerCase()
    : 'approval',
  trialDays: Math.max(0, parseInt(process.env.TRIAL_DAYS || '0', 10) || 0),
  // Dias de tolerância depois do vencimento antes de bloquear de fato.
  graceDays: Math.max(0, parseInt(process.env.GRACE_DAYS || '0', 10) || 0),

  // ---- Atrás do Nginx/Caddy: quantos "porteiros" existem na frente do sistema.
  // Necessário para o limite de tentativas enxergar o IP real da pessoa.
  trustProxy: parseInt(process.env.TRUST_PROXY || '1', 10),

  // ---- E-mail do SISTEMA (recuperação de senha, avisos). Independe do e-mail
  // que cada cliente configura em Configurações. Use o SMTP de qualquer provedor
  // (Brevo, Resend, Gmail com senha de app, Zoho...).
  systemSmtp: {
    host: process.env.SYSTEM_SMTP_HOST || '',
    port: parseInt(process.env.SYSTEM_SMTP_PORT || '587', 10),
    user: process.env.SYSTEM_SMTP_USER || '',
    pass: process.env.SYSTEM_SMTP_PASS || '',
    from: process.env.SYSTEM_MAIL_FROM || ''
  },
  supportContact: process.env.SUPPORT_CONTACT || '',
  appName: process.env.APP_NAME || 'Turbo Prospect',

  // ---- Cobrança automática (Asaas) ----
  asaas: {
    apiKey: process.env.ASAAS_API_KEY || '',
    env: String(process.env.ASAAS_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || ''
  },
  // Pagou => a conta pendente é liberada sozinha? (true = o pagamento é a aprovação)
  autoActivateOnPayment: String(process.env.AUTO_ACTIVATE_ON_PAYMENT || 'true').toLowerCase() !== 'false',

  // Opcionais: só use se o QR do WhatsApp parar de funcionar por
  // incompatibilidade de versão.
  whatsappWebVersion: process.env.WHATSAPP_WEB_VERSION || null,
  whatsappWebVersionCacheUrl: process.env.WHATSAPP_WEB_VERSION_CACHE_URL || null,

  // NOVO: Twilio direto pelo .env — se preenchidos, o sistema usa estes
  // valores automaticamente, sem precisar configurar nada pela tela
  // Configurações. Se você preencher pela tela também, o que estiver
  // salvo no banco tem prioridade sobre o .env.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
  // Número Twilio padrão, já cadastrado automaticamente em Linhas > Números
  // de Discagem na primeira vez que a tela é aberta, se ela estiver vazia.
  twilioCallerNumber: process.env.TWILIO_CALLER_NUMBER || null,
  // Remetente padrão de SMS da plataforma (número da Twilio com SMS, ID alfanumérico ou Messaging Service MG…). Só o administrador usa.
  twilioSmsFrom: process.env.TWILIO_SMS_FROM || null,
  // Remetente do e-mail da Twilio (precisa estar verificado/autenticado na Twilio). Só o administrador usa.
  twilioEmailFrom: process.env.TWILIO_EMAIL_FROM || null
};