// backend/src/routes/gateway.routes.js
const express = require('express');
const router = express.Router();
const c = require('../controllers/gatewayController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireRole(['owner', 'admin']));
router.use(requireFeature('gateway'));

router.get('/overview', c.overview);
router.put('/settings', c.saveSettings);
// Infraestrutura (fornecedores SMPP, troncos SIP, arquivos do Asterisk): SÓ o administrador da plataforma.
router.post('/carriers', requirePlatformAdmin, c.createCarrier);
router.put('/carriers/:id', requirePlatformAdmin, c.updateCarrier);
router.delete('/carriers/:id', requirePlatformAdmin, c.deleteCarrier);
router.post('/send', c.sendTest);
router.post('/segments', c.previewSegments);
router.get('/messages', c.listMessages);
router.delete('/messages/:id', c.cancelMessage);
router.get('/conversations', c.conversations);
router.get('/conversations/:number', c.conversation);
router.get('/wallet', c.walletMe);
router.get('/wallet/low', c.walletLow);
router.post('/wallet/topup', c.walletTopup);
router.put('/wallet/low-balance', c.walletLowBalance);
router.get('/wallet/statement', c.walletStatement);
router.get('/admin/billing-rules', requirePlatformAdmin, c.adminBillingRules);
router.put('/admin/billing-rules', requirePlatformAdmin, c.adminBillingRules);
router.get('/admin/profit', requirePlatformAdmin, c.adminProfit);
router.get('/wallet/accounts', requirePlatformAdmin, c.walletAccounts);
router.post('/wallet/:userId/credit', requirePlatformAdmin, c.walletCredit);
router.put('/wallet/:userId/rates', requirePlatformAdmin, c.walletRates);
router.get('/usage', c.usage);
router.get('/keys', c.listKeys);
router.post('/keys', c.createKey);
router.delete('/keys/:id', c.deleteKey);
router.put('/keys/:id/webhook', c.setKeyWebhook);
router.get('/trunks', requirePlatformAdmin, c.listTrunks);
router.post('/trunks', requirePlatformAdmin, c.createTrunk);
router.put('/trunks/:id', requirePlatformAdmin, c.updateTrunk);
router.delete('/trunks/:id', requirePlatformAdmin, c.deleteTrunk);
router.get('/voice/asterisk-config', requirePlatformAdmin, c.asteriskConfig);

module.exports = router;
