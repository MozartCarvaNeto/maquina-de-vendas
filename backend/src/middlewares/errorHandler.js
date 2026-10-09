// backend/src/middlewares/errorHandler.js
module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  // Erros de uso (ex.: dados inválidos, 4xx) não são falhas do sistema: log curto.
  if (status >= 500) console.error('❌ Erro não tratado:', err);
  else console.warn(`⚠️ ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  res.status(status).json({
    error: err.message || 'Erro interno do servidor'
  });
};