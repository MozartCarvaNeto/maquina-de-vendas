// backend/src/controllers/whatsappController.js
const prisma = require('../config/db');
const nativeWhatsappService = require('../services/whatsapp/nativeWhatsappService');
const whatsappDispatcher = require('../services/whatsapp/whatsappDispatcher');
const { checkLimit } = require('../services/planService');
const chatMediaService = require('../services/whatsapp/chatMediaService');
const fs = require('fs');

// ==================== CONEXÕES (SESSÕES NATIVAS) ====================

exports.listConnections = async (req, res, next) => {
  try {
    const connections = await prisma.whatsappConnection.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' }
    });
    // Nunca manda os segredos de verdade (token/app secret, mesmo
    // criptografados) para o navegador. O webhookVerifyToken não é um
    // segredo de acesso — é só o valor que o usuário cola no painel da
    // Meta — então esse pode continuar na resposta.
    const safeConnections = connections.map(({ accessTokenEnc, appSecretEnc, ...safe }) => safe);
    const limitInfo = await checkLimit(req.userId, 'connections');
    res.json({ connections: safeConnections, limit: limitInfo.limit });
  } catch (error) {
    next(error);
  }
};

/**
 * Cria a conexão e já inicia a sessão do WhatsApp em segundo plano.
 * O QR Code NÃO vem na resposta HTTP (ele demora alguns segundos para
 * ser gerado) — o frontend recebe em tempo real via Socket.IO, evento
 * "whatsapp:qr".
 */
exports.createConnection = async (req, res, next) => {
  try {
    const { instanceName } = req.body;
    if (!instanceName) {
      return res.status(400).json({ error: 'instanceName é obrigatório' });
    }

    // Limite do plano (sem plano: teto técnico de 10 conexões, como sempre foi).
    const limit = await checkLimit(req.userId, 'connections');
    if (!limit.ok) {
      return res.status(403).json({ error: limit.message, code: 'PLAN_LIMIT' });
    }

    const connection = await prisma.whatsappConnection.create({
      data: { userId: req.userId, instanceName, status: 'pendente' }
    });

    nativeWhatsappService
      .initSession({ id: connection.id, userId: req.userId, forceNew: true })
      .catch((err) => console.error(`Erro ao iniciar sessão ${connection.id}:`, err.message));

    res.status(201).json({ connection });
  } catch (error) {
    next(error);
  }
};

/**
 * Força a recriação da sessão (limpa arquivos em disco e gera novo QR).
 * Útil quando o QR não aparece.
 */
exports.reconnectConnection = async (req, res, next) => {
  try {
    const connection = await prisma.whatsappConnection.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!connection) {
      return res.status(404).json({ error: 'Conexão não encontrada' });
    }

    if (connection.provider === 'cloud_api') {
      return res.status(400).json({
        error: 'Esta conexão usa a API Oficial da Meta — não existe QR Code pra escanear de novo. Se o envio parou de funcionar, atualize o token de acesso.'
      });
    }

    // Encerra a sessão atual e limpa arquivos
    await nativeWhatsappService.destroySession(connection.id);

    await prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: { status: 'pendente' }
    });

    // Inicia uma nova sessão, forçando novo QR
    nativeWhatsappService
      .initSession({ id: connection.id, userId: req.userId, forceNew: true })
      .catch((err) => console.error(`Erro ao reconectar sessão ${connection.id}:`, err.message));

    res.json({ success: true, connection: { ...connection, status: 'pendente' } });
  } catch (error) {
    next(error);
  }
};

exports.checkStatus = async (req, res, next) => {
  try {
    const connection = await prisma.whatsappConnection.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!connection) {
      return res.status(404).json({ error: 'Conexão não encontrada' });
    }

    // Conexão Cloud API não tem sessão viva pra consultar — o status salvo
    // no banco já é a verdade (muda só quando o token é cadastrado/trocado).
    if (connection.provider === 'cloud_api') {
      return res.json({ connection });
    }

    const liveStatus = await nativeWhatsappService.getStatus(connection.id);
    if (liveStatus !== connection.status) {
      await prisma.whatsappConnection.update({ where: { id: connection.id }, data: { status: liveStatus } });
    }

    res.json({ connection: { ...connection, status: liveStatus } });
  } catch (error) {
    next(error);
  }
};

exports.deleteConnection = async (req, res, next) => {
  try {
    const connection = await prisma.whatsappConnection.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    if (!connection) {
      return res.status(404).json({ error: 'Conexão não encontrada' });
    }

    if (connection.provider !== 'cloud_api') {
      await nativeWhatsappService.destroySession(connection.id);
    }
    await prisma.whatsappConnection.delete({ where: { id: connection.id } });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ==================== MENSAGENS / CHAT ====================

exports.listConversations = async (req, res, next) => {
  try {
    const leadsWithMessages = await prisma.lead.findMany({
      where: { userId: req.userId, messages: { some: {} } },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });

    // Quem recebeu um relatório de ligação da IA e ainda NÃO teve resposta do vendedor fica marcado como
    // "aguardando": o vendedor vê de cara quem precisa de retorno.
    const ids = leadsWithMessages.map((l) => l.id);
    const notes = ids.length
      ? await prisma.message.findMany({
          where: { leadId: { in: ids }, direction: 'nota', channel: 'ia_relatorio' },
          orderBy: { createdAt: 'desc' },
          select: { leadId: true, createdAt: true, body: true }
        })
      : [];
    const replies = ids.length
      ? await prisma.message.groupBy({
          by: ['leadId'],
          where: { leadId: { in: ids }, direction: 'saida', channel: 'whatsapp' },
          _max: { createdAt: true }
        })
      : [];
    const lastReply = new Map(replies.map((r) => [r.leadId, r._max.createdAt]));
    const lastNote = new Map();
    for (const n of notes) if (!lastNote.has(n.leadId)) lastNote.set(n.leadId, n);

    const conversations = leadsWithMessages.map((lead) => {
      const note = lastNote.get(lead.id);
      let aiReport = null;
      if (note) {
        const outcome = (note.body.match(/Resultado:\s*(.+)/) || [])[1] || '';
        const qualifies = /quente|morno|retorno/i.test(outcome);
        const reply = lastReply.get(lead.id);
        aiReport = {
          at: note.createdAt,
          outcome: outcome.trim(),
          isTest: /TESTE/.test(note.body.split('\n')[0] || ''),
          awaitingSeller: qualifies && !(reply && reply > note.createdAt)
        };
      }
      return { ...lead, aiReport };
    });

    // Mais recente primeiro, pela última mensagem (a nota do relatório sobe a conversa para o topo).
    const lastAt = (l) => (l.messages[0] ? new Date(l.messages[0].createdAt).getTime() : 0);
    conversations.sort((a, b) => lastAt(b) - lastAt(a));

    res.json({ conversations });
  } catch (error) {
    next(error);
  }
};

exports.listConversation = async (req, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.leadId, userId: req.userId }
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }
    const messages = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ lead, messages });
  } catch (error) {
    next(error);
  }
};

exports.sendMessage = async (req, res, next) => {
  try {
    const { leadId, instanceId } = req.body;
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    const file = req.file || null;
    if (!leadId || !instanceId || (!text.trim() && !file)) {
      return res.status(400).json({ error: 'Informe o contato, o número e uma mensagem ou um arquivo.' });
    }
    if (file) {
      const fileError = chatMediaService.validateOutgoing(file);
      if (fileError) {
        if (file.path) fs.rm(file.path, { force: true }, () => null);
        return res.status(400).json({ error: fileError });
      }
    }

    const lead = await prisma.lead.findFirst({ where: { id: leadId, userId: req.userId } });
    if (!lead) {
      return res.status(404).json({ error: 'Lead não encontrado' });
    }
    if (!lead.phone) {
      return res.status(400).json({ error: 'Este lead não tem telefone cadastrado' });
    }

    const connection = await prisma.whatsappConnection.findFirst({
      where: { id: instanceId, userId: req.userId }
    });
    if (!connection) {
      return res.status(404).json({ error: 'Conexão de WhatsApp não encontrada' });
    }

    const sendableConnection = await whatsappDispatcher.loadConnectionForSending(connection.id);
    if (!whatsappDispatcher.isReady(sendableConnection)) {
      return res.status(409).json({ error: 'Esta conexão de WhatsApp não está pronta para envio no momento.' });
    }

    let mediaFields = {};
    if (file) {
      mediaFields = file.path
        ? chatMediaService.saveFromDisk(req.userId, file.path, file.size, file.mimetype, file.originalname)
        : chatMediaService.saveBuffer(req.userId, file.buffer, file.mimetype, file.originalname);
      const absolute = chatMediaService.resolvePath(mediaFields.mediaPath);
      try {
        await whatsappDispatcher.sendMessage(sendableConnection, lead.phone, text, absolute, {
          mimeType: mediaFields.mediaMime,
          fileName: mediaFields.mediaName,
          mediaMime: mediaFields.mediaMime,
          mediaName: mediaFields.mediaName,
          asDocument: mediaFields.mediaType === 'document' || mediaFields.mediaSize > chatMediaService.MAX_INLINE_MEDIA_BYTES
        });
      } catch (sendError) {
        fs.rm(absolute, { force: true }, () => null); // não deixa arquivo órfão se o envio falhou
        throw sendError;
      }
    } else {
      await whatsappDispatcher.sendMessage(sendableConnection, lead.phone, text);
    }

    const message = await prisma.message.create({
      data: { leadId: lead.id, direction: 'saida', channel: 'whatsapp', body: text, ...mediaFields }
    });

    const io = req.app.get('io');
    io.to(`user:${req.userId}`).emit('whatsapp:message', { leadId: lead.id, message });

    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
};

/**
 * Entrega o arquivo de uma mensagem (foto, documento, áudio, vídeo) — só para
 * quem é dono da conversa. O arquivo NÃO é público.
 */
exports.getMessageMedia = async (req, res, next) => {
  try {
    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, lead: { userId: req.userId } }
    });
    if (!message || !message.mediaPath) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    const absolute = chatMediaService.resolvePath(message.mediaPath);
    if (!absolute || !fs.existsSync(absolute)) {
      return res.status(404).json({ error: 'O arquivo não está mais no servidor' });
    }

    const type = message.mediaMime || 'application/octet-stream';
    // Tipos que o navegador mostra direto; o resto (e qualquer coisa suspeita) vai como download.
    const inline = /^(image\/(jpeg|png|webp|gif)|video\/|audio\/|application\/pdf)/.test(type);
    const safeName = encodeURIComponent(message.mediaName || 'arquivo');
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${inline && req.query.download !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`);
    res.sendFile(absolute, { headers: {} });
  } catch (error) {
    next(error);
  }
};
