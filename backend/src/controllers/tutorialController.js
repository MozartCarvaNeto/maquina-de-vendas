// backend/src/controllers/tutorialController.js
// Vídeos tutoriais (YouTube) por página. Leitura: qualquer usuário logado. Escrita: só admin da plataforma.
const prisma = require('../config/db');

/** Extrai o ID de 11 caracteres de links watch?v=, youtu.be, embed, shorts, live. */
function parseYoutubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else { const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/); if (m) id = m[2]; }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch (_) { return null; }
}

const validKey = (k) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(String(k || ''));

exports.parseYoutubeId = parseYoutubeId;

exports.list = async (req, res, next) => {
  try {
    const rows = await prisma.tutorialVideo.findMany();
    const out = {};
    for (const r of rows) out[r.pageKey] = { title: r.title, url: r.url, videoId: r.videoId };
    res.json(out);
  } catch (e) { next(e); }
};

exports.save = async (req, res, next) => {
  try {
    const pageKey = String(req.params.pageKey || '');
    if (!validKey(pageKey)) return res.status(400).json({ error: 'Página inválida.' });
    const url = String(req.body?.url || '').trim();
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const videoId = parseYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Link do YouTube inválido. Cole o endereço do vídeo (ex.: https://www.youtube.com/watch?v=...).' });
    if (!title) return res.status(400).json({ error: 'Informe o nome do vídeo (aparece ao lado da miniatura).' });
    const row = await prisma.tutorialVideo.upsert({
      where: { pageKey },
      update: { title, url, videoId },
      create: { pageKey, title, url, videoId }
    });
    res.json({ pageKey: row.pageKey, title: row.title, url: row.url, videoId: row.videoId });
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    const pageKey = String(req.params.pageKey || '');
    if (!validKey(pageKey)) return res.status(400).json({ error: 'Página inválida.' });
    await prisma.tutorialVideo.deleteMany({ where: { pageKey } });
    res.json({ ok: true });
  } catch (e) { next(e); }
};
