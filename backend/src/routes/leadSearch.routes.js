// backend/src/routes/leadSearch.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/leadSearchController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const { requireFeature } = require('../services/featureService');
const { createRateLimiter } = require('../middlewares/rateLimit');

// Cada busca no Google pode custar centavos para o cliente: limita abuso e cliques repetidos.
const searchLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 40,
  keyFn: (req) => `lead-search:${req.userId}`,
  message: 'Muitas buscas seguidas. Aguarde alguns minutos e tente de novo.'
});
const enrichLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120, keyFn: (req) => `lead-enrich:${req.userId}` });

router.use(auth);
router.use(requireFeature('contatos'));

router.get('/status', controller.status);
router.post('/key', requireRole(['owner', 'admin']), controller.saveKey);
router.delete('/key', requireRole(['owner', 'admin']), controller.removeKey);
router.post('/search', searchLimiter, controller.search);
router.post('/enrich', enrichLimiter, controller.enrich);
router.post('/import', controller.importSelected);

module.exports = router;
