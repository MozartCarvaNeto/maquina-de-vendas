// backend/src/routes/reseller.routes.js — painel do revendedor (só contas marcadas como revendedoras)
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const c = require('../controllers/resellerController');

router.use(auth);
router.use(requireRole(['owner']));
router.get('/', c.overview);
router.post('/clients', c.createClient);
router.put('/clients/:id/status', c.setStatus);
router.put('/clients/:id/rates', c.setRates);
router.post('/clients/:id/transfer', c.transfer);

module.exports = router;
