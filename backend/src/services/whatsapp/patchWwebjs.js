// backend/src/services/whatsapp/patchWwebjs.js
//
// Correção do envio de FOTOS/DOCUMENTOS/VÍDEOS pelo WhatsApp (QR Code).
// O WhatsApp Web mudou e a biblioteca whatsapp-web.js passou a falhar em
// qualquer envio de mídia com o erro:
//   "Data passed to getter must include an id property ... but got undefined"
// Causa: um campo interno (__x_id) da mídia sobrescreve o id da mensagem.
// Correção: remover esse campo antes de montar a mensagem.
// (bug conhecido: github.com/wwebjs/whatsapp-web.js/issues/201922)
//
// Este arquivo aplica a correção sozinho, a cada inicialização do sistema,
// de forma segura (não faz nada se já estiver aplicada ou se a biblioteca
// já vier corrigida). Precisa rodar ANTES de require('whatsapp-web.js').
const fs = require('fs');
const path = require('path');

const MARKER = 'TURBO-PATCH-MEDIA-ID';
const ANCHOR = "// Bot's won't reply if canonicalUrl is set (linking)";

function apply() {
  try {
    const pkgPath = require.resolve('whatsapp-web.js/package.json');
    const file = path.join(path.dirname(pkgPath), 'src', 'util', 'Injected', 'Utils.js');
    if (!fs.existsSync(file)) return;

    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(MARKER)) return; // já aplicada
    if (!source.includes(ANCHOR)) {
      console.warn('⚠️ patchWwebjs: trecho esperado não encontrado (versão diferente da biblioteca?). Envio de mídia pode falhar.');
      return;
    }
    if (source.indexOf(ANCHOR) !== source.lastIndexOf(ANCHOR)) return;

    const patch =
      `// ${MARKER}: o modelo da mídia traz um __x_id que sobrescrevia o id da mensagem\n` +
      '        delete message.__x_id;\n' +
      '        message.id = newMsgKey;\n\n' +
      `        ${ANCHOR}`;
    fs.writeFileSync(file, source.replace(ANCHOR, patch), 'utf8');
    console.log('🩹 Correção de envio de mídia do WhatsApp aplicada (whatsapp-web.js).');
  } catch (error) {
    console.warn(`⚠️ patchWwebjs não pôde ser aplicada: ${error.message}`);
  }
}

apply();
module.exports = { apply };
