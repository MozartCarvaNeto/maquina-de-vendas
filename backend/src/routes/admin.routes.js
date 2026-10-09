// backend/src/routes/admin.routes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');

router.use(auth, requirePlatformAdmin);

router.get('/overview', adminController.overview);
router.get('/accounts', adminController.listAccounts);
router.post('/accounts', adminController.createAccount);
router.get('/accounts/:id', adminController.getAccount);
router.patch('/accounts/:id', adminController.updateAccount);
router.post('/accounts/:id/approve', adminController.approve);
router.post('/accounts/:id/extend', adminController.extend);
router.post('/accounts/:id/block', adminController.block);
router.post('/accounts/:id/unblock', adminController.unblock);
router.post('/accounts/:id/reset-password', adminController.resetOwnerPassword);
router.post('/accounts/:id/plan', adminController.assignPlan);
router.post('/accounts/:id/charge', adminController.charge);
router.post('/accounts/:id/cancel-billing', adminController.cancelBilling);

router.get('/plans', adminController.listPlans);
router.post('/plans', adminController.createPlan);
router.patch('/plans/:id', adminController.updatePlan);
router.delete('/plans/:id', adminController.deletePlan);

module.exports = router;
