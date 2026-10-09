// backend/src/routes/emailDomains.routes.js
const express = require('express');
const router = express.Router();
const emailDomainController = require('../controllers/emailDomainController');
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');

router.use(auth);
router.use(requireRole(['owner', 'admin']));

router.get('/', emailDomainController.list);
router.post('/', emailDomainController.create);
router.patch('/:id/identity', emailDomainController.updateIdentity);
router.post('/:id/default', emailDomainController.setDefault);
router.get('/:id/dns-instructions', emailDomainController.getDnsInstructions);
router.post('/:id/verify', emailDomainController.verify);
router.delete('/:id', emailDomainController.remove);

module.exports = router;