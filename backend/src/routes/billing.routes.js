// backend/src/routes/billing.routes.js
const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const auth = require('../middlewares/auth');

// Estas rotas funcionam também para contas vencidas/pendentes (tela de pagamento).
router.get('/plans', auth, billingController.listPlans);
router.get('/status', auth, billingController.status);
router.post('/checkout', auth, billingController.checkout);
router.post('/cancel', auth, billingController.cancel);

module.exports = router;
