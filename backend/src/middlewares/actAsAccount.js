// backend/src/middlewares/actAsAccount.js
//
// Só para o ADMINISTRADOR DA PLATAFORMA: permite configurar a telefonia (URA, filas, rotas, áudios)
// "em nome de" uma conta de cliente, informando ?accountId=... (ou o cabeçalho x-act-as-account).
// Para qualquer outra pessoa o parâmetro é ignorado. Use SEMPRE depois do middleware "auth".
const prisma = require('../config/db');

module.exports = async function actAsAccount(req, res, next) {
  try {
    const wanted = String(req.query.accountId || req.headers['x-act-as-account'] || '').trim();
    if (!wanted || !req.isPlatformAdmin || wanted === req.userId) return next();
    const acc = await prisma.account.findUnique({ where: { id: wanted }, select: { id: true } });
    if (!acc) return res.status(404).json({ error: 'Conta do cliente não encontrada.' });
    req.actingAsAccountId = acc.id;
    req.userId = acc.id;
    next();
  } catch (e) {
    next(e);
  }
};
