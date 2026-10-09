// backend/src/routes/whatsappCloud.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsappCloudController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');
const requireRole = require('../middlewares/requireRole');

// Webhook: rota PÚBLICA, chamada pela Meta — não pode exigir login.
router.get('/webhook', controller.verifyWebhook);
router.post('/webhook', controller.handleWebhook);

router.use(auth);
router.use(requireRole(['owner', 'admin']));
router.use(requireFeature('conexoes'));
router.post('/', controller.create);
router.patch('/:id', controller.update);

module.exports = router;
