// backend/src/services/whatsapp/audioConvertService.js
//
// Áudio gravado no navegador sai em WEBM (Chrome) ou M4A (Safari), formatos que o WhatsApp não aceita
// como áudio. Se o servidor tiver o ffmpeg (a imagem Docker já traz), convertemos para OGG/Opus —
// o formato das mensagens de voz do WhatsApp — antes de enviar. Sem ffmpeg, o envio segue como estava.
const { spawn } = require('child_process');
const fs = require('fs');

let ffmpegChecked = false;
let ffmpegOk = false;

function isFfmpegAvailable() {
  if (ffmpegChecked) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version']);
    probe.on('error', () => {
      ffmpegChecked = true;
      ffmpegOk = false;
      resolve(false);
    });
    probe.on('close', (code) => {
      ffmpegChecked = true;
      ffmpegOk = code === 0;
      resolve(ffmpegOk);
    });
  });
}

/** Formatos que o WhatsApp já aceita como áudio, sem conversão. */
function isWhatsappFriendlyAudio(mime) {
  return /^audio\/(ogg|mpeg|mp3|mp4|x-m4a|aac|amr)$/.test(String(mime || '').split(';')[0].trim().toLowerCase());
}

/**
 * Converte para OGG/Opus mono. Devolve o caminho do arquivo novo ou null se não foi possível
 * (sem ffmpeg ou erro). O arquivo original NÃO é apagado aqui.
 */
async function convertToOggOpus(inputPath) {
  if (!(await isFfmpegAvailable())) return null;
  const outputPath = `${inputPath}.ogg`;
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-y', '-i', inputPath, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', outputPath]);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return resolve(outputPath);
      fs.rm(outputPath, { force: true }, () => null);
      resolve(null);
    });
  });
}

module.exports = { isFfmpegAvailable, isWhatsappFriendlyAudio, convertToOggOpus };
