// backend/src/services/smsgw/gsm.js
// Codificação e divisão (segmentação) de SMS: GSM 03.38 (7 bits), Latin-1 e UCS-2 (UTF-16BE).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = { '\f': 0x0a, '^': 0x14, '{': 0x28, '}': 0x29, '\\': 0x2f, '[': 0x3c, '~': 0x3d, ']': 0x3e, '|': 0x40, '€': 0x65 };

const BASIC_INDEX = new Map();
for (let i = 0; i < GSM_BASIC.length; i += 1) if (GSM_BASIC[i] !== '\u001b') BASIC_INDEX.set(GSM_BASIC[i], i);

/** Troca letras acentuadas que não existem no GSM por equivalentes simples (á→a, ã→a, ç fica, etc.). */
function stripAccents(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, (m) => '')
    .normalize('NFC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...');
}

function isGsm7(text) {
  for (const ch of String(text)) if (!BASIC_INDEX.has(ch) && !(ch in GSM_EXT)) return false;
  return true;
}

/** Texto -> septetos (um por byte, "unpacked"), com a tabela de extensão (€, {, }...). */
function toGsm7Units(text) {
  const units = [];
  for (const ch of String(text)) {
    if (BASIC_INDEX.has(ch)) units.push([BASIC_INDEX.get(ch)]);
    else if (ch in GSM_EXT) units.push([0x1b, GSM_EXT[ch]]);
    else units.push([BASIC_INDEX.get('?')]);
  }
  return units; // cada item = um caractere (1 ou 2 septetos)
}

function toUcs2Units(text) {
  const units = [];
  for (const ch of String(text)) {
    const b = Buffer.from(ch, 'utf16le');
    b.swap16();
    units.push([...b]);
  }
  return units;
}

function toLatin1Units(text) {
  return [...String(text)].map((ch) => [ch.charCodeAt(0) <= 255 ? ch.charCodeAt(0) : 0x3f]);
}

/**
 * Prepara o texto para envio.
 * @param {string} text
 * @param {{normalize?: 'keep'|'strip', charset?: 'gsm7'|'latin1'}} opts
 * @returns {{encoding:'gsm7'|'latin1'|'ucs2', dataCoding:number, segments:Buffer[], parts:number}}
 *   segments = corpo de cada parte, SEM cabeçalho de concatenação.
 */
function encodeSms(text, opts = {}) {
  let body = String(text || '');
  if (opts.normalize === 'strip') body = stripAccents(body);

  let encoding;
  let units;
  let dataCoding;
  let single;
  let multi;
  if (isGsm7(body) && opts.charset !== 'latin1') {
    encoding = 'gsm7';
    units = toGsm7Units(body);
    dataCoding = 0x00;
    single = 160;
    multi = 153;
  } else if (opts.charset === 'latin1' && [...body].every((c) => c.charCodeAt(0) <= 255)) {
    encoding = 'latin1';
    units = toLatin1Units(body);
    dataCoding = 0x03;
    single = 140;
    multi = 134;
  } else {
    encoding = 'ucs2';
    units = toUcs2Units(body);
    dataCoding = 0x08;
    single = 140; // bytes (70 caracteres)
    multi = 134; // bytes (67 caracteres)
  }

  const sizeOf = (u) => u.length;
  const total = units.reduce((s, u) => s + sizeOf(u), 0);
  const limitSingle = encoding === 'ucs2' ? 140 : single;
  const limitMulti = encoding === 'ucs2' ? 134 : multi;

  const chunks = [];
  if (total <= limitSingle) {
    chunks.push(units.flat());
  } else {
    let current = [];
    let size = 0;
    for (const u of units) {
      if (size + u.length > limitMulti) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(...u);
      size += u.length;
    }
    if (current.length) chunks.push(current);
  }
  if (!chunks.length) chunks.push([]);
  return { encoding, dataCoding, segments: chunks.map((c) => Buffer.from(c)), parts: chunks.length };
}

/** Quantas partes (segmentos) o SMS vai gastar — usado para cobrança e para mostrar na tela. */
function countSegments(text, opts = {}) {
  const { parts, encoding } = encodeSms(text, opts);
  return { parts, encoding };
}

/** Decodifica o texto de uma mensagem recebida (MO) conforme data_coding. */
function decodeSms(buffer, dataCoding) {
  if (dataCoding === 0x08 || dataCoding === 0x1) {
    if (dataCoding === 0x1) return buffer.toString('ascii');
    const b = Buffer.from(buffer);
    b.swap16();
    return b.toString('utf16le');
  }
  if (dataCoding === 0x03) return buffer.toString('latin1');
  // GSM 7 bits (data_coding 0) — SMSCs variam; tratamos como septetos desempacotados.
  let out = '';
  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i];
    if (c === 0x1b && i + 1 < buffer.length) {
      const ext = Object.entries(GSM_EXT).find(([, code]) => code === buffer[i + 1]);
      out += ext ? ext[0] : '';
      i += 1;
    } else {
      out += GSM_BASIC[c] || '';
    }
  }
  return out;
}

module.exports = { encodeSms, countSegments, decodeSms, stripAccents, isGsm7 };
