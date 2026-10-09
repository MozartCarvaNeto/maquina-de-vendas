// backend/src/middlewares/requireRole.js

/**
 * Middleware de autorização por papel. Use SEMPRE depois do middleware "auth".
 * Exemplo: router.post('/', auth, requireRole(['owner', 'admin']), controller.create)
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.memberRole || !allowedRoles.includes(req.memberRole)) {
      return res.status(403).json({
        error: 'Você não tem permissão para realizar esta ação. Fale com um administrador da conta.'
      });
    }
    next();
  };
}

module.exports = requireRole;