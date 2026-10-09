// backend/src/routes/whatsapp.routes.js
const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);

router.get('/connections', requireFeature('conexoes'), whatsappController.listConnections);
router.post('/connections', requireFeature('conexoes'), whatsappController.createConnection);
router.get('/connections/:id/status', requireFeature('conexoes'), whatsappController.checkStatus);
router.post('/connections/:id/reconnect', requireFeature('conexoes'), whatsappController.reconnectConnection);
router.delete('/connections/:id', requireFeature('conexoes'), whatsappController.deleteConnection);

router.get('/conversations', requireFeature('chat'), whatsappController.listConversations);
router.get('/conversations/:leadId', requireFeature('chat'), whatsappController.listConversation);
router.post('/messages', requireFeature('chat'), whatsappController.sendMessage);

module.exports = router;