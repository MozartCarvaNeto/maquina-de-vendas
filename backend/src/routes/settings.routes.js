// backend/src/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');

router.use(auth);
router.use(requireRole(['owner', 'admin']));

router.get('/providers', settingsController.listAvailableProviders);
router.get('/env-status', settingsController.getEnvStatus);
router.get('/', settingsController.listMySettings);
router.post('/telephony', settingsController.saveTelephonySettings);
router.post('/ai-telephony', settingsController.saveAiTelephonySettings);
router.post('/email', settingsController.saveEmailSettings);
router.post('/sms', settingsController.saveSmsSettings);
router.post('/sms/test', settingsController.testSms);
router.post('/email/test', settingsController.testEmail);
router.delete('/:category/:provider', settingsController.deleteProviderSettings);
router.delete('/:id', settingsController.deleteSetting);

module.exports = router;