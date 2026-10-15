// backend/src/utils/phone.js
//
// Converte telefones digitados de qualquer jeito para o formato internacional (E.164) que a operadora exige.
// O app é brasileiro: número SEM código de país é tratado como número do Brasil (+55).
// Antes, "85 99856-9283" virava "+85998569283" (o DDD era lido como código de país) e a Twilio recusava.

/** @returns {string|null} ex.: "+5585998569283", ou null se não der para formar um número válido */
function toE164BR(raw) {
  const text = String(raw || '').trim();
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;

  // Digitou "+" (ou 00): já vem com código do país.
  if (text.startsWith('+') || digits.startsWith('00')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // Zero de tronco: 0 + DDD + número (ex.: 085 99856-9283).
  if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) digits = digits.slice(1);

  // Já começa com 55 e tem tamanho de número brasileiro (12 ou 13 dígitos).
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return `+${digits}`;

  // DDD + número (10 ou 11 dígitos): Brasil.
  if (digits.length === 10 || digits.length === 11) {
    // Celular antigo sem o 9 (DDD + 8 dígitos começando por 6-8): acrescenta o 9.
    if (digits.length === 10 && /^[6-8]/.test(digits.slice(2))) digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
    return `+55${digits}`;
  }

  // 12 a 15 dígitos sem "+": assume que já tem código de país.
  if (digits.length >= 12 && digits.length <= 15) return `+${digits}`;

  return null;
}

module.exports = { toE164BR };
