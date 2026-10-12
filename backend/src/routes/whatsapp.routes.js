// backend/src/routes/whatsapp.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

const chatMediaService = require('../services/whatsapp/chatMediaService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: chatMediaService.MAX_SEND_BYTES, files: 1 }
});

// Aceita JSON (só texto) ou multipart (texto + 1 arquivo).
function handleChatUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'O arquivo ultrapassa o limite de 16 MB.' : err.message || 'Erro ao receber o arquivo.';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

router.use(auth);

router.get('/connections', requireFeature('conexoes'), whatsappController.listConnections);
router.post('/connections', requireFeature('conexoes'), whatsappController.createConnection);
router.get('/connections/:id/status', requireFeature('conexoes'), whatsappController.checkStatus);
router.post('/connections/:id/reconnect', requireFeature('conexoes'), whatsappController.reconnectConnection);
router.delete('/connections/:id', requireFeature('conexoes'), whatsappController.deleteConnection);

router.get('/conversations', requireFeature('chat'), whatsappController.listConversations);
router.get('/conversations/:leadId', requireFeature('chat'), whatsappController.listConversation);
router.post('/messages', requireFeature('chat'), handleChatUpload, whatsappController.sendMessage);
router.get('/messages/:messageId/media', requireFeature('chat'), whatsappController.getMessageMedia);

module.exports = router;