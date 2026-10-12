// backend/src/routes/aiSettings.routes.js
const express = require('express');
const router = express.Router();
const aiSettingsController = require('../controllers/aiSettingsController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');

router.use(auth);

// Leitura: qualquer membro logado (Campanhas e Agente IA precisam saber quais IAs existem).
router.get('/', aiSettingsController.listMyProviders);

// Alterar chaves: só dono/administrador.
router.get('/providers', requireRole(['owner', 'admin']), aiSettingsController.listAvailableProviders);
router.post('/', requireRole(['owner', 'admin']), aiSettingsController.saveProvider);
router.delete('/:provider', requireRole(['owner', 'admin']), aiSettingsController.deleteProvider);

module.exports = router;
