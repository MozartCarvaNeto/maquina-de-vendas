// backend/src/routes/campaigns.routes.js
const express = require('express');
const router = express.Router();
const campaignsController = require('../controllers/campaignsController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireFeature('contatos'));

router.get('/', campaignsController.list);
router.get('/:id', campaignsController.getById);
router.post('/', campaignsController.create);
router.put('/:id', campaignsController.update);
router.delete('/:id', campaignsController.remove);

module.exports = router;