// backend/src/socket.js
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('./config/env');
const prisma = require('./config/db');
const { checkMemberAccess } = require('./services/accessService');

function initSocket(server, frontendUrl) {
  const io = new Server(server, {
    cors: {
      origin: frontendUrl,
      credentials: true
    }
  });

  // SEGURANÇA: antes, qualquer pessoa conseguia "entrar na sala" de qualquer
  // empresa só informando o id (e receberia QR Code e mensagens dela). Agora a
  // conexão exige o token de login e a sala é definida pelo servidor.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));

      const decoded = jwt.verify(token, env.jwtSecret);
      const member = await prisma.member.findUnique({
        where: { id: decoded.memberId },
        include: { account: true }
      });
      if (!member || member.status !== 'ativo') return next(new Error('unauthorized'));

      const access = checkMemberAccess(member, member.account);
      if (!access.allowed) return next(new Error(access.code || 'forbidden'));

      socket.data.accountId = member.accountId;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const room = `user:${socket.data.accountId}`;
    socket.join(room);
    console.log(`🔌 Cliente conectado: ${socket.id} (sala ${room})`);

    // Mantido só por compatibilidade com versões antigas do frontend: o id
    // enviado pelo navegador é IGNORADO (a sala já foi definida acima).
    socket.on('join-user', () => {});

    socket.on('disconnect', () => {
      console.log('🔌 Cliente desconectado:', socket.id);
    });
  });

  return io;
}

module.exports = { initSocket };
