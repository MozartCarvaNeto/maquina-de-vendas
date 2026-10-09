// backend/src/controllers/whatsappCloudController.js
const prisma = require('../config/db');
const metaCloudApiService = require('../services/whatsapp/metaCloudApiService');
const whatsappDispatcher = require('../services/whatsapp/whatsappDispatcher');
const whatsappIncomingService = require('../services/whatsapp/whatsappIncomingService');

exports.create = async (req, res, next) => {
  try {
    const { instanceName, phoneNumberId, wabaId, accessToken, appSecret } = req.body;
    const connection = await metaCloudApiService.createConnection(req.userId, {
      instanceName,
      phoneNumberId,
      wabaId,
      accessToken,
      appSecret
    });
    const { accessTokenEnc, appSecretEnc, ...safe } = connection;
    res.status(201).json({
      connection: safe,
      webhookUrl: `${require('../config/env').backendPublicUrl.replace(/\/$/, '')}/api/whatsapp-cloud/webhook`
    });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { accessToken, appSecret } = req.body;
    const connection = await metaCloudApiService.updateConnection(req.userId, req.params.id, { accessToken, appSecret });
    const { accessTokenEnc, appSecretEnc, ...safe } = connection;
    res.json({ connection: safe });
  } catch (error) {
    next(error);
  }
};

// ==================== WEBHOOK (público, chamado pela Meta) ====================

/** Handshake de verificação: a Meta chama isso uma vez, ao salvar a URL do webhook no painel dela. */
exports.verifyWebhook = async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) return res.sendStatus(403);

  const match = await prisma.whatsappConnection.findFirst({ where: { provider: 'cloud_api', webhookVerifyToken: token } });
  if (!match) return res.sendStatus(403);

  res.status(200).send(challenge);
};

/** Mensagens recebidas e atualizações de status (entregue/lido) — chega aqui pra TODOS os números cadastrados. */
exports.handleWebhook = async (req, res) => {
  // Responde rápido sempre — a Meta reenvia (e pode até desativar o
  // webhook) se demorar ou se não vier 200, então confirma antes de
  // processar com calma.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.metadata?.phone_number_id) continue;

        const connection = await prisma.whatsappConnection.findFirst({
          where: { provider: 'cloud_api', phoneNumberId: value.metadata.phone_number_id }
        });
        if (!connection) continue; // webhook de um número que não é desta conta — ignora

        if (connection.appSecretEnc) {
          const appSecret = require('../services/crypto/settingsCrypto').decrypt(connection.appSecretEnc);
          const signature = req.headers['x-hub-signature-256'];
          if (!metaCloudApiService.verifyWebhookSignature(req.rawBody, signature, appSecret)) {
            console.warn(`⚠️ Webhook da Meta com assinatura inválida para a conexão ${connection.id} — ignorado.`);
            continue;
          }
        }

        for (const message of value.messages || []) {
          if (message.type !== 'text') continue; // áudio/imagem/etc podem ser adicionados depois
          const contact = (value.contacts || []).find((c) => c.wa_id === message.from);

          await whatsappIncomingService.processIncomingMessage({
            userId: connection.userId,
            connectionId: connection.id,
            phone: message.from,
            text: message.text?.body || '',
            contactName: contact?.profile?.name,
            sendReply: async (replyText) => {
              const ready = await whatsappDispatcher.loadConnectionForSending(connection.id);
              await whatsappDispatcher.sendMessage(ready, message.from, replyText);
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('Erro ao processar webhook da Meta:', error.message);
  }
};
