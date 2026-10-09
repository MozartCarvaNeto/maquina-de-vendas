// backend/src/services/ai/voice/catalogService.js
//
// Catálogo do agente de voz:
//  1) lê o texto do site (home + algumas páginas de produto/categoria) e
//     também dados estruturados de produto (JSON-LD), quando existirem;
//  2) na hora da ligação, escolhe só os trechos relevantes para a fala do lead
//     (assim o prompt fica pequeno, a resposta rápida e o custo baixo, mesmo
//     com catálogos grandes).
const axios = require('axios');

const MAX_WEB_CHARS = 60000;
const MAX_PAGES = 10;
const FETCH_TIMEOUT_MS = 15000;
const PRODUCT_URL_HINT = /(produto|product|colec|collection|categoria|category|shop|loja|catalog|joia|piercing|labret|argola|barbell|titanio)/i;
const SKIP_URL = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|pdf|zip|mp4|woff2?)(\?|$)/i;

// ---------------------------------------------------------------- HTML -> texto

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Produtos descritos em JSON-LD (Shopify, WooCommerce, Nuvemshop etc. costumam trazer).
function extractJsonLdProducts(html) {
  const lines = [];
  const blocks = String(html || '').match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = [].concat(node['@type'] || []).join(',');
    if (/Product/i.test(type) && node.name) {
      const offer = [].concat(node.offers || [])[0] || {};
      const price = offer.price || offer.lowPrice;
      const parts = [`Produto: ${String(node.name).trim()}`];
      if (price) parts.push(`preço ${offer.priceCurrency === 'BRL' || !offer.priceCurrency ? 'R$ ' : ''}${price}`);
      if (node.description) parts.push(String(node.description).replace(/\s+/g, ' ').slice(0, 240));
      lines.push(parts.join(' — '));
    }
    if (node['@graph']) visit(node['@graph']);
    if (node.itemListElement) visit(node.itemListElement);
    if (node.item) visit(node.item);
  };
  for (const block of blocks) {
    const json = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    try {
      visit(JSON.parse(json));
    } catch {
      // JSON-LD inválido: ignora
    }
  }
  return lines;
}

// ---------------------------------------------------------------- download

function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    const err = new Error('Endereço do site inválido. Use algo como https://www.seusite.com.br');
    err.status = 400;
    throw err;
  }
  if (!/^https?:$/.test(url.protocol)) {
    const err = new Error('O endereço do site precisa começar com http:// ou https://');
    err.status = 400;
    throw err;
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === '::1';
  if (isPrivate) {
    const err = new Error('Por segurança, endereços locais/internos não podem ser usados como catálogo.');
    err.status = 400;
    throw err;
  }
  return url;
}

async function fetchPage(url) {
  const { data } = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: 3 * 1024 * 1024,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaquinaDeVendasBot/1.0)', Accept: 'text/html' }
  });
  return String(data || '');
}

function collectLinks(html, base) {
  const found = [];
  const seen = new Set();
  const regex = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const link = new URL(match[1], base);
      link.hash = '';
      if (link.host !== base.host || SKIP_URL.test(link.pathname)) continue;
      const key = link.origin + link.pathname;
      if (seen.has(key) || key === base.origin + base.pathname) continue;
      seen.add(key);
      found.push(link.toString());
    } catch {
      // link inválido: ignora
    }
  }
  // Páginas com cara de produto/categoria primeiro.
  return found.sort((a, b) => Number(PRODUCT_URL_HINT.test(b)) - Number(PRODUCT_URL_HINT.test(a)));
}

/** Lê o site e devolve o texto para o agente usar como catálogo. */
async function fetchSiteCatalog(rawUrl) {
  const base = assertSafeUrl(rawUrl);
  const parts = [];
  let totalChars = 0;
  let pages = 0;

  const addPage = (url, html) => {
    const products = extractJsonLdProducts(html);
    const text = htmlToText(html);
    const block = [`### Página: ${url}`, ...products, text].filter(Boolean).join('\n');
    if (totalChars + block.length > MAX_WEB_CHARS) {
      parts.push(block.slice(0, Math.max(0, MAX_WEB_CHARS - totalChars)));
      totalChars = MAX_WEB_CHARS;
    } else {
      parts.push(block);
      totalChars += block.length;
    }
    pages += 1;
  };

  let homeHtml;
  try {
    homeHtml = await fetchPage(base.toString());
  } catch (error) {
    const err = new Error(`Não consegui abrir o site (${error.message}). Confira o endereço ou cole o catálogo em texto.`);
    err.status = 400;
    throw err;
  }
  addPage(base.toString(), homeHtml);

  const links = collectLinks(homeHtml, base).slice(0, MAX_PAGES - 1);
  for (const link of links) {
    if (totalChars >= MAX_WEB_CHARS) break;
    try {
      addPage(link, await fetchPage(link));
    } catch {
      // página que falhar é simplesmente pulada
    }
  }

  const text = parts.join('\n\n').trim();
  if (text.length < 80) {
    const err = new Error('O site abriu, mas não encontrei texto legível (pode ser um site que só carrega por JavaScript). Cole o catálogo em texto.');
    err.status = 400;
    throw err;
  }
  return { text, pages, chars: text.length };
}

// ---------------------------------------------------------------- busca de trechos

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  'de da do das dos para por com sem uma uns umas que como mais menos sao tem ter ser esta esse essa isso aqui alem voce voces nos eles elas pra pro nao sim muito pouco tambem entao agora quando onde qual quais seu sua seus suas meu minha'.split(' ')
);

function tokens(text) {
  return normalize(text)
    .split(' ')
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function chunkText(text, maxLen = 700) {
  const chunks = [];
  let current = '';
  for (const line of String(text || '').split(/\n+/)) {
    const clean = line.trim();
    if (!clean) continue;
    if ((current + ' | ' + clean).length > maxLen && current) {
      chunks.push(current);
      current = clean;
    } else {
      current = current ? `${current} | ${clean}` : clean;
    }
    while (current.length > maxLen * 1.6) {
      chunks.push(current.slice(0, maxLen));
      current = current.slice(maxLen);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Cache dos blocos do catálogo (evita reprocessar o texto a cada fala).
const chunkCache = new Map();

function getChunks(agent) {
  const key = `${agent.id}:${agent.updatedAt ? new Date(agent.updatedAt).getTime() : 0}`;
  if (chunkCache.has(key)) return chunkCache.get(key);
  const source = [agent.catalogText, agent.catalogWebText].filter(Boolean).join('\n\n');
  const chunks = chunkText(source);
  if (chunkCache.size > 40) chunkCache.clear();
  chunkCache.set(key, chunks);
  return chunks;
}

/**
 * Monta o trecho de catálogo para o prompt: sempre o começo do catálogo (que
 * costuma ter condições comerciais) + os blocos mais parecidos com o assunto
 * da conversa. Limite total ~5.000 caracteres.
 */
function buildCatalogContext(agent, query) {
  const chunks = getChunks(agent);
  if (chunks.length === 0) return '(nenhum catálogo cadastrado — não cite produtos, preços ou prazos; diga que o consultor informa)';

  const MAX_TOTAL = 5000;
  const head = chunks.slice(0, 2);
  const queryTokens = new Set(tokens(query));

  let picked = [];
  if (queryTokens.size > 0 && chunks.length > head.length) {
    picked = chunks
      .slice(head.length)
      .map((chunk) => {
        const words = new Set(tokens(chunk));
        let score = 0;
        queryTokens.forEach((word) => {
          if (words.has(word)) score += 1 + Math.min(word.length, 10) / 10;
        });
        return { chunk, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((item) => item.chunk);
  } else {
    picked = chunks.slice(head.length, head.length + 4);
  }

  let out = '';
  for (const chunk of [...head, ...picked]) {
    if (out.length + chunk.length + 3 > MAX_TOTAL) break;
    out += `- ${chunk}\n`;
  }
  return out.trim();
}

module.exports = { fetchSiteCatalog, buildCatalogContext, htmlToText, extractJsonLdProducts, chunkText, normalize };
