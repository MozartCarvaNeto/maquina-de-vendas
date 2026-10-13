// Tipos de arquivo que o WhatsApp/e-mail aceitam como anexo no Chat e nos Disparos.
export const ATTACHMENT_REGEX =
  /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|quicktime)|application\/pdf|application\/zip|application\/msword|application\/vnd\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\.[a-z.]+)|text\/(plain|csv))$/;

export const BLOCKED_EXT_REGEX = /\.(exe|bat|cmd|com|scr|msi|js|jse|vbs|ps1|sh|jar|apk|dll|php|html?|svg)$/i;

export const ATTACHMENT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Chat: aceita também ÁUDIO (arquivo ou gravação) e confere pela extensão quando o navegador não informa o tipo.
export const CHAT_ATTACHMENT_REGEX =
  /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|quicktime)|audio\/(ogg|mpeg|mp3|mp4|x-m4a|aac|amr|wav|x-wav|webm|opus)|application\/pdf|application\/zip|application\/msword|application\/vnd\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\.[a-z.]+)|text\/(plain|csv))$/;

export const CHAT_ATTACHMENT_ACCEPT = `${ATTACHMENT_ACCEPT},audio/*,.mp3,.ogg,.opus,.m4a,.aac,.amr,.wav,.jpg,.jpeg,.png`;

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', wav: 'audio/wav'
};

/**
 * Devolve o arquivo com um tipo confiável, ou { error } se não puder ser enviado.
 * Alguns navegadores/sistemas deixam o tipo vazio (PDF arrastado, .docx, .ogg): aí vale a extensão.
 */
export function normalizeChatFile(file) {
  if (!file) return { error: 'Nenhum arquivo selecionado.' };
  const name = file.name || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (BLOCKED_EXT_REGEX.test(name)) return { error: 'Este tipo de arquivo (executável/script) não pode ser enviado.' };
  if (ext === 'heic' || ext === 'heif') return { error: 'Fotos HEIC do iPhone não são aceitas. Envie como JPG (no iPhone: Ajustes > Câmera > Formatos > "Mais compatível").' };

  let type = String(file.type || '').split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream') type = EXT_MIME[ext] || '';
  if (!CHAT_ATTACHMENT_REGEX.test(type)) {
    return { error: 'Formato não permitido. Envie foto (JPG, PNG, WebP), vídeo MP4, áudio (MP3, OGG, M4A, WAV), PDF, Word, Excel, PowerPoint, TXT, CSV ou ZIP.' };
  }
  const base = String(file.type || '').split(';')[0].trim().toLowerCase();
  return { file: base === type ? file : new File([file], name || `arquivo.${ext || 'bin'}`, { type }) };
}
