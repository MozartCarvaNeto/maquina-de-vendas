// backend/src/routes/leadLists.routes.js
const express = require('express');
const router = express.Router();
const leadListController = require('../controllers/leadListController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireFeature('contatos'));

router.get('/', leadListController.list);
router.post('/', leadListController.create);
router.post('/preview-dynamic', leadListController.previewDynamicFilter);
router.get('/:id', leadListController.getById);
router.put('/:id', leadListController.update);
router.post('/:id/members', leadListController.addMembers);
router.delete('/:id/members/:leadId', leadListController.removeMember);
router.delete('/:id', leadListController.remove);

module.exports = router;