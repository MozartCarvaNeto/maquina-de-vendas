// backend/src/routes/aiSettings.routes.js
const express = require('express');
const router = express.Router();
const aiSettingsController = require('../controllers/aiSettingsController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');

router.use(auth);
router.use(requireRole(['owner', 'admin']));

router.get('/providers', aiSettingsController.listAvailableProviders);
router.get('/', aiSettingsController.listMyProviders);
router.post('/', aiSettingsController.saveProvider);
router.delete('/:provider', aiSettingsController.deleteProvider);

module.exports = router;