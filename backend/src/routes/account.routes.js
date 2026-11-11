// backend/src/routes/account.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const requireRole = require('../middlewares/requireRole');
const c = require('../controllers/accountController');
const { requireFeature } = require('../services/featureService');
const manager = requireRole(['owner', 'admin']);

router.use(auth);
router.get('/fiscal', manager, c.getFiscal);
router.put('/fiscal', manager, c.saveFiscal);
router.get('/receipts', manager, c.receipts);
router.get('/receipts/:kind/:id', manager, c.receipt);
router.get('/plan-usage', c.planUsage);
router.get('/onboarding', manager, c.onboarding);
router.post('/onboarding/dismiss', manager, c.onboardingDismiss);
// lista de bloqueio: qualquer membro vê e adiciona; só dono/admin remove
router.get('/opt-outs', c.optOutList);
router.post('/opt-outs', c.optOutAdd);
router.delete('/opt-outs/:id', manager, c.optOutRemove);
router.get('/referral', c.referral);
router.get('/brand', c.brandGet);
router.put('/brand', manager, requireFeature('marca_propria'), c.brandSave);
router.get('/email-suppressions', c.emailSuppressionList);
router.post('/email-suppressions', c.emailSuppressionAdd);
router.delete('/email-suppressions/:id', manager, c.emailSuppressionRemove);

module.exports = router;
