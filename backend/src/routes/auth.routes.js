// backend/src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rateLimit');

const HOUR = 60 * 60 * 1000;
const emailOf = (req) => String(req.body?.email || '').trim().toLowerCase();
const limitRegister = createRateLimiter({ windowMs: HOUR, max: 10, message: 'Muitos cadastros deste endereço. Tente novamente mais tarde.' });
const limitForgotByIp = createRateLimiter({ windowMs: HOUR, max: 10, message: 'Muitos pedidos de recuperação. Tente novamente em alguns minutos.' });
const limitForgotByEmail = createRateLimiter({ windowMs: HOUR, max: 3, keyFn: (req) => `fp:${emailOf(req)}`, message: 'Já enviamos instruções para este e-mail. Aguarde um pouco antes de pedir de novo.' });
const limitReset = createRateLimiter({ windowMs: HOUR, max: 10, message: 'Muitas tentativas. Tente novamente mais tarde.' });

router.post('/register', limitRegister, authController.register);
router.post('/login', authController.login);
router.post('/forgot-password', limitForgotByIp, limitForgotByEmail, authController.forgotPassword);
router.post('/reset-password', limitReset, authController.resetPassword);
router.get('/me', auth, authController.me);

module.exports = router;