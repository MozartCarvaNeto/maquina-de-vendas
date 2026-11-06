// backend/src/routes/voice.routes.js
const express = require('express');
const router = express.Router();
const c = require('../controllers/voiceController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireFeature('gateway'));

router.get('/me', c.me);
router.get('/lookup', c.lookup);
router.post('/calls', c.logCall);
router.get('/calls', c.listCalls);

module.exports = router;
