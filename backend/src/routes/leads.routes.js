// backend/src/routes/leads.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const leadsController = require('../controllers/leadsController');
const auth = require('../middlewares/auth');
const { requireFeature } = require('../services/featureService');

// Aceita CSV e Excel (.xlsx/.xls) na importação de contatos — o parsing de
// cada formato é feito em leadsController.importCsv, que detecta o tipo
// pelo nome do arquivo/mimetype.
const ALLOWED_IMPORT_MIMETYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel', // .xls e também alguns navegadores mandam .csv assim
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/plain',
  'application/octet-stream' // fallback: alguns SOs não identificam o mimetype corretamente
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB é de sobra para listas de milhares de contatos
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const validExtension = name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls');
    const validMimetype = ALLOWED_IMPORT_MIMETYPES.has(file.mimetype);
    if (!validExtension && !validMimetype) {
      return cb(new Error('Envie um arquivo .csv, .xlsx ou .xls'));
    }
    cb(null, true);
  }
});

router.use(auth);
router.use(requireFeature('contatos'));

router.get('/', leadsController.list);
router.get('/:id', leadsController.getById);
router.post('/', leadsController.create);
router.post('/import-csv', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Erro ao processar o arquivo enviado' });
    next();
  });
}, leadsController.importCsv);
router.post('/:id/qualify', leadsController.qualify);
router.post('/:id/opt-out', leadsController.optOut);
router.put('/:id', leadsController.update);
router.delete('/:id', leadsController.remove);

router.post('/bulk/campaign', leadsController.bulkAssignCampaign);
router.post('/bulk/channel', leadsController.bulkSetPreferredChannel);
router.post('/bulk/enqueue-calls', leadsController.bulkEnqueueCalls);
router.post('/bulk/add-to-crm', leadsController.bulkAddToCrm);

module.exports = router;