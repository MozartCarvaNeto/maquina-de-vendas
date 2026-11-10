// backend/src/routes/legal.routes.js — textos públicos (sem login)
const express = require('express');
const router = express.Router();
const c = require('../controllers/accountController');
router.get('/', c.legalPublic);
module.exports = router;
