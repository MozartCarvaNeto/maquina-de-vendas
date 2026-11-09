// backend/src/routes/pbx.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/pbxController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
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
// Números (DID): estoque e atribuição aos clientes — só o administrador da plataforma.
router.get('/admin/dids', requirePlatformAdmin, c.adminDids);
router.post('/admin/dids', requirePlatformAdmin, c.adminAddDids);
router.post('/admin/dids/assign', requirePlatformAdmin, c.adminAssignDids);
router.post('/admin/dids/unassign', requirePlatformAdmin, c.adminUnassignDids);
router.delete('/admin/dids/:id', requirePlatformAdmin, c.adminDeleteDid);
router.put('/admin/did-settings', requirePlatformAdmin, c.adminDidSettings);
router.put('/admin/dids/:id', requirePlatformAdmin, c.adminUpdateDid);
router.get('/admin/dids/:id/history', requirePlatformAdmin, c.adminDidHistory);
router.post('/admin/did-run', requirePlatformAdmin, c.adminRunDidJob);
router.get('/admin/asterisk-host', requirePlatformAdmin, c.adminAsteriskHost);
router.put('/admin/asterisk-host', requirePlatformAdmin, c.adminSaveAsteriskHost);
router.post('/admin/asterisk-host/test', requirePlatformAdmin, c.adminTestAsteriskHost);
router.post('/admin/apply-all', requirePlatformAdmin, c.adminApplyAll);
router.get('/live', admin, c.live);
router.post('/live/spy', admin, c.spy);
router.post('/live/hangup', admin, c.hangupLive);
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
// Chaves dos motores de voz (Google/Azure/Amazon/ElevenLabs/OpenAI) e testes: só o administrador da plataforma.
router.get('/voice-engines', requirePlatformAdmin, c.voiceEngines);
router.put('/voice-engines/:provider', requirePlatformAdmin, c.saveVoiceEngine);
router.delete('/voice-engines/:provider', requirePlatformAdmin, c.deleteVoiceEngine);
router.post('/voices/test', requirePlatformAdmin, c.voiceTest);
router.post('/voices/stt-test', requirePlatformAdmin, c.sttTest);
router.get('/config', requirePlatformAdmin, c.config);
router.post('/apply', requirePlatformAdmin, c.apply);

module.exports = router;
