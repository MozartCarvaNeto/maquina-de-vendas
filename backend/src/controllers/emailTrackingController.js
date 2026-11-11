// backend/src/controllers/emailTrackingController.js
const emailTrackingService = require('../services/email/emailTrackingService');

exports.openPixel = async (req, res) => {
  const token = String(req.params.token || '').replace(/\.gif$/i, '');
  // Nunca falha visivelmente: um pixel quebrado no cliente de e-mail do
  // destinatário fica feio e não ajuda em nada.
  emailTrackingService.registerOpen(token).catch(() => {});

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': emailTrackingService.TRANSPARENT_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(emailTrackingService.TRANSPARENT_GIF);
};

exports.clickRedirect = async (req, res) => {
  const token = String(req.params.token || '');
  const target = String(req.query.u || '');

  emailTrackingService.registerClick(token).catch(() => {});

  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).send('Link inválido.');
  }
  res.redirect(302, target);
};

exports.unsubscribePage = async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const message = await emailTrackingService.registerUnsubscribe(token);

    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!message) {
      return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;">Link de descadastro inválido ou já usado.</body></html>');
    }
    res.send(`
      <html>
        <body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#333;">
          <h2>Você foi descadastrado</h2>
          <p>O endereço <strong>${message.toEmail}</strong> não vai mais receber e-mails deste remetente.</p>
        </body>
      </html>
    `);
  } catch (error) {
    next(error);
  }
};

/** Chamado automaticamente pelo Gmail/Yahoo/Outlook quando a pessoa clica em "Cancelar inscrição" no topo do e-mail (RFC 8058 — descadastro em um clique só). */
exports.unsubscribeOneClick = async (req, res) => {
  const token = String(req.params.token || '');
  await emailTrackingService.registerUnsubscribe(token).catch(() => {});
  res.status(200).json({ success: true });
};

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function page(body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelar inscrição</title></head><body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 16px;text-align:center;color:#333;">${body}</body></html>`;
}

// GET só MOSTRA a confirmação (antivírus/scanners de e-mail abrem links
// sozinhos; descadastrar no GET cancelaria pessoas sem querer).
exports.signedUnsubscribePage = (req, res) => {
  const data = emailTrackingService.parseSignedUnsubToken(req.params.token);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!data) return res.status(404).send(page('Link de descadastro inválido.'));
  res.send(page(`<h2>Cancelar inscrição</h2>
    <p>Deseja parar de receber e-mails em <strong>${escHtml(data.email)}</strong>?</p>
    <form method="POST"><button type="submit" style="padding:12px 28px;font-size:16px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer;">Sim, cancelar inscrição</button></form>`));
};

// POST: botão da página OU "um clique" do Gmail/Outlook (RFC 8058).
exports.signedUnsubscribeDo = async (req, res, next) => {
  try {
    const data = await emailTrackingService.registerSignedUnsubscribe(req.params.token);
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (!wantsHtml) return res.status(data ? 200 : 404).json({ success: !!data });
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!data) return res.status(404).send(page('Link de descadastro inválido.'));
    res.send(page(`<h2>Você foi descadastrado</h2><p>O endereço <strong>${escHtml(data.email)}</strong> não vai mais receber e-mails deste remetente.</p>`));
  } catch (error) {
    next(error);
  }
};
