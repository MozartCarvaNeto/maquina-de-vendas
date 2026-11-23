// backend/src/routes/nfe.routes.js — área do cliente (emissor de NF-e)
const express = require('express');
const router = express.Router();
const c = require('../controllers/nfeController');
const auth = require('../middlewares/auth');

router.use(auth);
router.get('/status', c.status);
router.post('/checkout', c.checkout);
router.post('/cancel', c.cancel);
router.post('/session', c.session);

module.exports = router;
