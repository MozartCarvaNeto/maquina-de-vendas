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
