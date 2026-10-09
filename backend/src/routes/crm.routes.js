// backend/src/routes/crm.routes.js
const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crmController');
const crmFollowUpController = require('../controllers/crmFollowUpController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

router.use(auth);
router.use(requireFeature('crm'));

// Retorno agendado e clientes perdidos (precisa vir antes das rotas com :id genérico)
router.get('/followups/summary', crmFollowUpController.summary);

router.get('/boards', crmController.listBoards);
router.post('/boards', crmController.createBoard);
router.get('/boards/:boardId', crmController.getBoard);
router.delete('/boards/:boardId', crmController.deleteBoard);

router.post('/boards/:boardId/columns', crmController.createColumn);
router.put('/columns/:columnId', crmController.updateColumn);
router.delete('/columns/:columnId', crmController.deleteColumn);
router.post('/columns/:columnId/cards', crmController.createCardManually);

router.put('/cards/:cardId', crmController.updateCard);
router.post('/cards/:cardId/move', crmController.moveCard);
router.delete('/cards/:cardId', crmController.deleteCard);

router.put('/cards/:cardId/followup', crmFollowUpController.schedule);
router.post('/cards/:cardId/followup/done', crmFollowUpController.markDone);
router.post('/cards/:cardId/lost', crmFollowUpController.markLost);
router.post('/cards/:cardId/reactivate', crmFollowUpController.reactivate);

module.exports = router;