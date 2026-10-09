// backend/src/routes/callQueue.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/manualCallQueueController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

// Qualquer pessoa logada na conta pode discar manualmente — é para isso que existe.
router.use(auth);
router.use(requireFeature('discador'));

router.get('/lists', controller.listAvailableLists);
router.get('/:listId', controller.getQueue);
router.post('/:listId/outcome', controller.postOutcome);
router.post('/:listId/undo', controller.undo);

module.exports = router;
