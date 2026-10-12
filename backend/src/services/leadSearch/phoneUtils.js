// backend/src/services/leadSearch/phoneUtils.js
// Padroniza telefones de empresas encontradas na busca (Brasil por padrão).

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Celular brasileiro = 55 + DDD + 9 + 8 dígitos. Só celular costuma ter WhatsApp. */
function isBrazilMobile(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 13 && d.startsWith('55') && d[4] === '9';
}

/** Chave para detectar duplicados: últimos 8 dígitos (ignora DDI, DDD e 9º dígito). */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

module.exports = { normalizePhone, isBrazilMobile, phoneKey };
