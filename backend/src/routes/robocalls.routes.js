// backend/src/routes/robocalls.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const roboCallController = require('../controllers/roboCallController');
const roboCallWebhookController = require('../controllers/roboCallWebhookController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');
const requireRole = require('../middlewares/requireRole');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\/(mpeg|mp3|wav|x-wav|wave)$/i.test(file.mimetype || '');
    if (!ok) return cb(new Error('Os áudios precisam estar em MP3 ou WAV.'));
    cb(null, true);
  }
});

const audioFields = upload.fields([
  { name: 'introAudio', maxCount: 1 },
  { name: 'interestedAudio', maxCount: 1 },
  { name: 'notInterestedAudio', maxCount: 1 }
]);

function handleUpload(req, res, next) {
  audioFields(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Erro ao processar o áudio.' });
    next();
  });
}

// Webhooks públicos (chamados pela Twilio, sem JWT)
router.post('/webhook/status', roboCallWebhookController.handleStatus);
router.post('/webhook/gather', roboCallWebhookController.handleGather);
router.post('/webhook/recording', roboCallWebhookController.handleRecording);

router.use(auth);
router.use(requireRole(['owner', 'admin']));
router.use(requireFeature('robo'));

router.get('/', roboCallController.list);
router.post('/', handleUpload, roboCallController.create);
router.post('/preview-audience', roboCallController.previewAudience);
router.get('/:id', roboCallController.getById);
router.get('/:id/calls', roboCallController.getCalls);
router.post('/:id/start', roboCallController.start);
router.post('/:id/pause', roboCallController.pause);
router.delete('/:id', roboCallController.remove);

module.exports = router;
