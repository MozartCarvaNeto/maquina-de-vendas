// backend/src/routes/publicMedia.routes.js
// Imagens dos disparos de RCS precisam de um endereço público (a operadora/provedor baixa a imagem).
// O nome do arquivo é um UUID impossível de adivinhar; só imagens são servidas.
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const ROOT = path.join(__dirname, '../../uploads/broadcast-attachments');
const ID_RE = /^[0-9a-f-]{36}$/i;
const FILE_RE = /^[0-9a-f-]{36}\.(jpe?g|png|gif|webp)$/i;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

router.get('/:broadcastId/:filename', (req, res) => {
  const { broadcastId, filename } = req.params;
  if (!ID_RE.test(broadcastId) || !FILE_RE.test(filename)) return res.status(404).end();
  const file = path.join(ROOT, broadcastId, filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', TYPES[filename.split('.').pop().toLowerCase()]);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  fs.createReadStream(file).pipe(res);
});

module.exports = router;
