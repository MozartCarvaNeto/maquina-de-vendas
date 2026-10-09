// backend/src/routes/lines.routes.js
const express = require('express');
const router = express.Router();
const lineController = require('../controllers/lineController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');
const requireRole = require('../middlewares/requireRole');

router.use(auth);
router.use(requireFeature('discador', 'robo', 'agente_ia'));

router.get('/caller-numbers', lineController.listCallerNumbers);
router.post('/caller-numbers', requireRole(['owner', 'admin']), lineController.createCallerNumber);
router.put('/caller-numbers/:id', requireRole(['owner', 'admin']), lineController.updateCallerNumber);
router.delete('/caller-numbers/:id', requireRole(['owner', 'admin']), lineController.deleteCallerNumber);

router.get('/agents', lineController.listAgents);
router.post('/agents', requireRole(['owner', 'admin']), lineController.createAgent);
router.put('/agents/:id', requireRole(['owner', 'admin']), lineController.updateAgent);
router.delete('/agents/:id', requireRole(['owner', 'admin']), lineController.deleteAgent);

module.exports = router;