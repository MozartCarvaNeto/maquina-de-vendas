// backend/src/routes/broadcasts.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const broadcastController = require('../controllers/broadcastController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');
const chatMediaService = require('../services/whatsapp/chatMediaService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!chatMediaService.isAllowedAttachment(file)) {
      return cb(new Error('Formato não permitido. Use foto (JPG, PNG, WebP), vídeo MP4, PDF, Word, Excel, PowerPoint, TXT, CSV ou ZIP.'));
    }
    cb(null, true);
  }
});

router.use(auth);
router.use(requireFeature('disparos'));

function handleUpload(req, res, next) {
  upload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Erro ao processar a imagem.' });

    // O disparo de WhatsApp leva 1 anexo (foto, vídeo, PDF...). E-mail aceita até 10 MB por arquivo.
    if (req.body?.channel === 'whatsapp' && req.files?.length > 1) {
      return res.status(400).json({ error: 'No WhatsApp, anexe apenas 1 arquivo por disparo.' });
    }
    if (req.body?.channel === 'email' && req.files?.some((f) => f.size > 10 * 1024 * 1024)) {
      return res.status(400).json({ error: 'Cada anexo de e-mail pode ter no máximo 10 MB.' });
    }

    next();
  });
}

router.get('/', broadcastController.list);
router.post('/', handleUpload, broadcastController.create);
router.post('/preview-audience', broadcastController.previewAudience);
router.get('/:id', broadcastController.getById);
router.get('/:id/recipients', broadcastController.getRecipients);
router.get('/:id/progress', broadcastController.getProgress);
router.post('/:id/pause-resume', broadcastController.pauseResume);
router.delete('/:id', broadcastController.remove);

module.exports = router;
