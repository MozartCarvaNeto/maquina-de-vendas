// backend/src/routes/pbxHook.routes.js
// Chamados só pelo Asterisk do próprio servidor (protegido por um código secreto na URL).
const express = require('express');
const router = express.Router();
const c = require('../controllers/pbxHookController');

router.get('/event', c.event);
router.get('/ai-next', c.aiNext);
router.get('/ai-end', c.aiEnd);

module.exports = router;
