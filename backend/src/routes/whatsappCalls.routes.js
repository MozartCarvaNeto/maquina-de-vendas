// backend/src/routes/whatsappCalls.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsappCallsController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireFeature('chat'));

router.get('/config', controller.config);
router.get('/connections/:connectionId/settings', controller.settings);
router.post('/connections/:connectionId/enable', controller.enable);
router.post('/outgoing', controller.outgoing);
router.post('/permission', controller.permission);
router.post('/:callId/accept', controller.accept);
router.post('/:callId/reject', controller.reject);
router.post('/:callId/terminate', controller.terminate);

module.exports = router;
