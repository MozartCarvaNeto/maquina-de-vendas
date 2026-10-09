// backend/src/routes/team.routes.js
const express = require('express');
const router = express.Router();
const teamController = require('../controllers/teamController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');

router.use(auth);

router.get('/', teamController.list);
router.post('/', requireRole(['owner', 'admin']), teamController.invite);
router.put('/:id', requireRole(['owner', 'admin']), teamController.update);
router.post('/:id/reset-password', requireRole(['owner', 'admin']), teamController.resetMemberPassword);
router.delete('/:id', requireRole(['owner', 'admin']), teamController.remove);

module.exports = router;