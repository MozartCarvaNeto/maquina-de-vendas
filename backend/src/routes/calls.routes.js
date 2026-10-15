// backend/src/routes/calls.routes.js
const express = require('express');
const router = express.Router();
const callsController = require('../controllers/callsController');
const callsWebhookController = require('../controllers/callsWebhookController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

// Webhooks públicos (chamados pela Twilio, sem JWT)
router.post('/webhook/twilio', callsWebhookController.handleTwilioWebhook);
router.post('/webhook/recording', callsWebhookController.handleRecordingStatusWebhook);

router.use(auth);
router.use(requireFeature('discador'));

router.get('/settings', callsController.getDialerSettings);
router.post('/settings', callsController.saveDialerSettings);

router.get('/queue', callsController.getQueue);
router.post('/queue/next', callsController.startNext);
router.post('/queue/load-list', callsController.loadList);
router.get('/team', callsController.getTeam);
router.post('/agents/:id/pause', callsController.setAgentPause);

router.post('/click-to-call', callsController.clickToCall);
router.post('/:id/hangup', callsController.hangup);
router.get('/:id/recording', callsController.getRecording);
router.get('/', callsController.listHistory);

module.exports = router;