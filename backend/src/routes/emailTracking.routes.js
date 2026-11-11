// backend/src/routes/emailTracking.routes.js
//
// Rotas PÚBLICAS (sem login) — são acessadas pelo cliente de e-mail do
// destinatário (Gmail, Outlook, etc.), então não podem exigir token JWT.
const express = require('express');
const router = express.Router();
const emailTrackingController = require('../controllers/emailTrackingController');

router.get('/o/:token', emailTrackingController.openPixel);
router.get('/c/:token', emailTrackingController.clickRedirect);
router.get('/u/:token', emailTrackingController.unsubscribePage);
router.post('/u/:token', emailTrackingController.unsubscribeOneClick);
// Descadastro por link assinado (qualquer provedor): GET mostra confirmação, POST descadastra.
router.get('/s/:token', emailTrackingController.signedUnsubscribePage);
router.post('/s/:token', express.urlencoded({ extended: false }), emailTrackingController.signedUnsubscribeDo);

module.exports = router;