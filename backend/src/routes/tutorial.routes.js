// backend/src/routes/tutorial.routes.js — leitura dos vídeos tutoriais (qualquer usuário logado)
const express = require('express');
const router = express.Router();
const c = require('../controllers/tutorialController');
const auth = require('../middlewares/auth');

router.get('/', auth, c.list);

module.exports = router;
