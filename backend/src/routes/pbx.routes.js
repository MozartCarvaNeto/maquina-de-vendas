// backend/src/routes/pbx.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/pbxController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const { requireFeature } = require('../services/featureService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

router.use(auth);
router.use(requireFeature('gateway'));

// Qualquer pessoa da equipe com a função liberada pode ouvir gravações e usar clique-para-ligar; o resto é do admin.
router.post('/click-to-call', c.clickToCall);

const admin = requireRole(['owner', 'admin']);
router.get('/calls', admin, c.listCalls);
router.get('/calls/:id/recording', admin, c.streamRecording);
router.get('/overview', admin, c.overview);
router.put('/settings', admin, c.saveSettings);
router.post('/audios', admin, upload.single('file'), c.uploadAudio);
router.post('/audios/tts', admin, c.ttsAudio);
router.get('/audios/:id/file', admin, c.audioFile);
router.delete('/audios/:id', admin, c.deleteAudio);
router.post('/ivrs', admin, c.saveIvr);
router.put('/ivrs/:id', admin, c.saveIvr);
router.delete('/ivrs/:id', admin, c.deleteIvr);
router.post('/queues', admin, c.saveQueue);
router.put('/queues/:id', admin, c.saveQueue);
router.delete('/queues/:id', admin, c.deleteQueue);
router.post('/routes', admin, c.saveRoute);
router.put('/routes/:id', admin, c.saveRoute);
router.delete('/routes/:id', admin, c.deleteRoute);
router.get('/voice-engines', admin, c.voiceEngines);
router.put('/voice-engines/:provider', admin, c.saveVoiceEngine);
router.delete('/voice-engines/:provider', admin, c.deleteVoiceEngine);
router.post('/voices/test', admin, c.voiceTest);
router.post('/voices/stt-test', admin, c.sttTest);
router.get('/config', admin, c.config);
router.post('/apply', admin, c.apply);

module.exports = router;
