// backend/src/routes/aiCalls.routes.js
const express = require('express');
const router = express.Router();
const aiCallController = require('../controllers/aiCallController');
const aiCallWebhookController = require('../controllers/aiCallWebhookController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');
const requireRole = require('../middlewares/requireRole');

// Webhooks públicos (chamados pela Twilio, sem JWT)
router.post('/webhook/status', aiCallWebhookController.handleStatus);
router.post('/webhook/turn', aiCallWebhookController.handleTurn);
router.post('/webhook/dial-result', aiCallWebhookController.handleDialResult);
router.post('/webhook/recording', aiCallWebhookController.handleRecording);

router.use(auth);
router.use(requireRole(['owner', 'admin']));
router.use(requireFeature('agente_ia'));

router.get('/options', aiCallController.options);

router.get('/agents', aiCallController.listAgents);
router.post('/agents', aiCallController.createAgent);
router.get('/agents/:id', aiCallController.getAgent);
router.put('/agents/:id', aiCallController.updateAgent);
router.delete('/agents/:id', aiCallController.deleteAgent);
router.post('/agents/:id/refresh-catalog', aiCallController.refreshCatalog);
router.get('/agents/:id/simulate/opening', aiCallController.simulateOpening);
router.post('/agents/:id/simulate', aiCallController.simulate);
router.post('/agents/:id/test-call', aiCallController.testCall);

router.get('/campaigns', aiCallController.listCampaigns);
router.post('/campaigns', aiCallController.createCampaign);
router.post('/campaigns/preview-audience', aiCallController.previewAudience);
router.post('/campaigns/:id/start', aiCallController.startCampaign);
router.post('/campaigns/:id/pause', aiCallController.pauseCampaign);
router.get('/campaigns/:id/calls', aiCallController.getCampaignCalls);
router.delete('/campaigns/:id', aiCallController.removeCampaign);

router.get('/sessions/tests/recent', aiCallController.listTestSessions);
router.get('/sessions/:sessionId', aiCallController.getSession);

module.exports = router;
