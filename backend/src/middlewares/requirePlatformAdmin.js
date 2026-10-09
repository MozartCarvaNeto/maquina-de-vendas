// backend/src/middlewares/requirePlatformAdmin.js
//
// Libera a rota só para os ADMINISTRADORES DA PLATAFORMA (e-mails listados em
// SUPERADMIN_EMAILS no .env). Use SEMPRE depois do middleware "auth".
function requirePlatformAdmin(req, res, next) {
  if (!req.isPlatformAdmin) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador da plataforma.' });
  }
  next();
}

module.exports = requirePlatformAdmin;
