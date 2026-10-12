// backend/src/services/ai/voice/pronunciation.js
//
// A voz da ligação é em português (Polly pt-BR). Quando o texto traz uma palavra em inglês — muito
// comum em nome de empresa ("Piercing Express") — ela lê as letras como se fosse português e soa
// errado. Aqui trocamos, SÓ na hora de falar, a palavra por uma grafia que a voz em português lê
// do jeito certo. O texto salvo na conversa e enviado por WhatsApp continua com a grafia original.
//
// Ordem de prioridade: (1) "Como pronunciar" cadastrado no glossário do agente;
// (2) dicionário abaixo, com palavras em inglês comuns em nomes de empresas brasileiras.

const BUILT_IN = {
  piercing: 'Pírsin',
  piercings: 'Pírsins',
  express: 'Ispréss',
  store: 'Estór',
  shop: 'Chóp',
  jewelry: 'Djúelri',
  jewellery: 'Djúelri',
  body: 'Bódi',
  tattoo: 'Tatú',
  design: 'Dizáin',
  group: 'Grúpi',
  premium: 'Prêmium',
  outlet: 'Autlét',
  center: 'Sênter',
  online: 'onláin',
  delivery: 'delívery',
  whatsapp: 'Uótsápi',
  'e-mail': 'imêiu',
  email: 'imêiu',
  business: 'bíznis',
  marketing: 'márketin',
  trade: 'tréid',
  import: 'ímport',
  gold: 'gôuld',
  silver: 'sílver',
  piercer: 'pírser',
  barbell: 'bárbel',
  labret: 'labrét',
  threadless: 'trédles',
  'push pin': 'push pin'
};

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEntries(agent) {
  const entries = new Map();
  for (const [term, say] of Object.entries(BUILT_IN)) entries.set(term.toLowerCase(), say);

  const glossary = Array.isArray(agent?.glossary) ? agent.glossary : [];
  for (const item of glossary) {
    const term = String(item?.term || '').trim();
    const say = String(item?.pronunciation || '').trim();
    if (term && say) entries.set(term.toLowerCase(), say); // o do usuário vence o padrão
  }
  return entries;
}

/** Devolve o texto com os termos trocados pela grafia falada. */
function applyPronunciation(text, agent) {
  let out = String(text || '');
  if (!out) return out;

  // Termos mais longos primeiro ("push pin" antes de "pin").
  const entries = [...buildEntries(agent).entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [term, say] of entries) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(pattern, say);
  }
  return out;
}

module.exports = { applyPronunciation, BUILT_IN };
