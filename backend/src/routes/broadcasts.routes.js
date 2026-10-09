// backend/src/routes/broadcasts.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const broadcastController = require('../controllers/broadcastController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Só é permitido anexar arquivos de imagem.'));
    }
    cb(null, true);
  }
});

router.use(auth);
router.use(requireFeature('disparos'));

function handleUpload(req, res, next) {
  upload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Erro ao processar a imagem.' });

    // O disparo de WhatsApp aceita exatamente uma imagem JPEG/JPG.
    if (req.body?.channel === 'whatsapp' && req.files?.length) {
      if (req.files.length > 1) {
        return res.status(400).json({ error: 'No WhatsApp, anexe apenas 1 imagem JPEG.' });
      }
      const file = req.files[0];
      if (file.mimetype !== 'image/jpeg') {
        return res.status(400).json({ error: 'A imagem do WhatsApp deve estar no formato JPEG/JPG.' });
      }
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
