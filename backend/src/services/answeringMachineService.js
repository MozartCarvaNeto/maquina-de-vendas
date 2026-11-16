// backend/src/services/answeringMachineService.js
//
// Detecta quando quem "atendeu" NÃO é uma pessoa: caixa postal de operadora, secretária eletrônica do iPhone/Android,
// triagem de chamadas (Google/iPhone), URA de empresa, aviso de "número inexistente / desligado / fora de área".
//
// Camadas (a primeira que reconhecer encerra a ligação):
//  1) Detecção pelo áudio na operadora/PBX (AMD da Twilio e do Asterisk) — ver callsWebhookController.handleAmd.
//  2) Este classificador de TEXTO, aplicado ao que o STT ouviu (ligações da IA e do robô).
//  3) Heurísticas: monólogo longo logo no início, mesma fala repetida (gravação em loop).
//
// Uma pessoa de verdade ("alô?", "quem fala?", "não posso atender agora, me liga depois") NUNCA deve ser tomada como
// máquina: frases ambíguas só valem sozinhas quando não há sinal de pessoa. Puro (sem banco): tests/answeringMachine.test.js.

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9#*\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// kind: caixa_postal | triagem | operadora | invalido | ura
// ---- FORTES: só máquina fala assim
const STRONG = {
  caixa_postal: [
    'caixa postal', 'caixa de mensagem', 'caixa de mensagens', 'caixa de voz', 'correio de voz', 'secretaria eletronica',
    'secretaria virtual', 'atendedor automatico', 'deixe sua mensagem', 'deixe seu recado', 'deixe um recado', 'deixe uma mensagem',
    'deixe o seu recado', 'deixe a sua mensagem', 'deixar uma mensagem', 'deixar um recado', 'deixar seu recado', 'deixar sua mensagem',
    'grave sua mensagem', 'grave seu recado', 'grave o seu recado', 'grave a sua mensagem', 'gravar sua mensagem', 'gravar seu recado',
    'gravar uma mensagem', 'gravar um recado', 'apos o sinal', 'apos o bip', 'apos o bipe', 'apos o beep', 'apos o tom', 'depois do sinal',
    'depois do bip', 'depois do bipe', 'depois do beep', 'depois do tom', 'ao ouvir o sinal', 'sinal sonoro', 'aguarde o sinal',
    'aguarde o bip', 'aguarde o bipe', 'quando terminar a gravacao', 'quando terminar de gravar', 'ao terminar a gravacao',
    'ao terminar de gravar', 'quando terminar desligue', 'quando terminar basta desligar', 'ao terminar desligue',
    'para enviar sua mensagem', 'para regravar', 'para gravar novamente', 'para ouvir sua mensagem', 'para mais opcoes',
    'encaminhada para a caixa', 'encaminhada para o correio de voz', 'caixa postal do numero', 'caixa postal cheia',
    'a caixa postal esta cheia', 'nao e possivel deixar mensagem', 'voce chegou a caixa', 'voce chegou ao correio',
    'este e o correio', 'esta e a caixa', 'este e o atendedor', 'a pessoa que voce ligou', 'a pessoa para quem voce ligou',
    'a pessoa que voce esta chamando', 'a pessoa que voce esta tentando', 'o assinante', 'usuario que voce esta chamando',
    'cliente que voce esta chamando', 'o numero que voce ligou', 'o numero para o qual voce ligou', 'o numero que voce chamou', 'o numero chamado',
    'voce ligou para o numero', 'nao esta disponivel no momento', 'nao esta disponivel agora', 'nao se encontra disponivel',
    'nao pode atender', 'nao podem atender', 'nao podemos atender no momento', 'no momento nao podemos atender',
    'nao estamos disponiveis no momento', 'nao estamos em condicoes de atender', 'retornaremos sua ligacao', 'ligaremos de volta',
    'entraremos em contato assim que possivel', 'assim que possivel retornaremos',
    'leave a message', 'leave your message', 'after the tone', 'after the beep', 'voicemail', 'voice mail', 'the person you are trying to reach'
  ],
  operadora: [
    'telefone desligado', 'celular desligado', 'aparelho desligado', 'esta desligado', 'encontra se desligado', 'desligado ou fora da area',
    'desligado ou fora de area', 'fora da area de cobertura', 'fora de area de cobertura', 'area de cobertura', 'temporariamente indisponivel',
    'temporariamente fora de servico', 'temporariamente suspenso', 'fora de servico', 'nao recebe chamadas', 'nao pode receber chamadas',
    'nao esta recebendo chamadas', 'chamadas a cobrar', 'nao aceita chamadas', 'a ligacao nao pode ser completada', 'sua ligacao nao pode ser completada',
    'nao foi possivel completar', 'nao pode ser completada', 'tente novamente mais tarde', 'tente sua ligacao mais tarde', 'ligue novamente mais tarde',
    'todas as linhas estao ocupadas', 'todos os circuitos estao ocupados', 'circuitos ocupados', 'o telefone chamado', 'o celular chamado',
    'aparelho chamado', 'terminal chamado', 'vivo informa', 'claro informa', 'tim informa', 'oi informa', 'algar informa', 'nextel informa',
    'operadora informa', 'creditos insuficientes', 'sem creditos', 'sem saldo', 'faca uma recarga', 'chamada nao autorizada',
    'ligacao nao autorizada', 'chamada bloqueada', 'servico indisponivel', 'aguarde na linha', 'permaneca na linha', 'continue na linha'
  ],
  invalido: [
    'numero nao existe', 'chamado nao existe', 'chamado esta incorreto', 'chamado nao esta em servico', 'numero inexistente', 'numero incorreto', 'numero invalido', 'numero nao cadastrado', 'numero nao esta cadastrado',
    'numero nao esta em servico', 'numero nao esta mais em servico', 'numero fora de servico', 'nao esta em servico', 'numero desativado',
    'linha desativada', 'linha cancelada', 'verifique o numero', 'confira o numero', 'numero discado', 'o numero discado', 'foi alterado',
    'numero foi alterado', 'numero trocado', 'codigo de area', 'como discada', 'is not in service', 'has been disconnected', 'no longer in service'
  ],
  triagem: [
    'triagem de chamada', 'triagem de chamadas', 'servico de triagem', 'filtro de chamada', 'filtro de chamadas', 'filtragem de chamada',
    'filtragem de chamadas', 'recurso de filtragem', 'assistente do google', 'assistente de chamada', 'assistente de ligacao',
    'copia desta conversa', 'copia desta ligacao', 'transcricao desta conversa', 'transcricao desta ligacao', 'diga seu nome e o motivo',
    'diga o seu nome e o motivo', 'diga seu nome e o assunto', 'informe seu nome e o motivo', 'informe o seu nome e o motivo',
    'informe seu nome e o assunto', 'informe o motivo da ligacao', 'informe o motivo da sua ligacao', 'diga o motivo da ligacao',
    'diga o motivo da sua ligacao', 'qual o motivo da ligacao', 'qual e o motivo da ligacao', 'qual o motivo da sua ligacao',
    'qual e o motivo da sua ligacao', 'qual o assunto da ligacao', 'disser seu nome e o motivo', 'disser o seu nome e o motivo',
    'grave seu nome', 'gravar seu nome', 'depois do sinal diga', 'vou ver se esta pessoa esta disponivel', 'vou ver se ele esta disponivel',
    'vou ver se ela esta disponivel', 'ver se a pessoa esta disponivel', 'verificar se esta pessoa esta disponivel', 'se esta pessoa esta disponivel',
    'nao reconheco este numero', 'nao reconheco esse numero', 'call screening', 'screening service', 'state your name', 'reason for calling',
    'esta chamada esta sendo transcrita', 'esta ligacao esta sendo transcrita', 'chamada esta sendo analisada', 'atendida por um assistente'
  ],
  ura: [
    'digite um', 'digite o numero', 'digite a opcao', 'digite o ramal', 'digite o cpf', 'digite o cnpj', 'digite seu cpf', 'digite seu cnpj',
    'digite o seu cpf', 'digite o codigo', 'digite a senha', 'digite o ddd', 'tecle um', 'tecle dois', 'tecle tres', 'tecle quatro',
    'tecle cinco', 'tecle zero', 'tecle 1', 'tecle 2', 'tecle 3', 'tecle 4', 'tecle 5', 'tecle 9', 'tecle 0', 'tecle o ramal', 'tecle asterisco',
    'tecle jogo da velha', 'tecle cerquilha', 'tecle sustenido', 'pressione um', 'pressione dois', 'pressione tres', 'pressione quatro',
    'pressione zero', 'pressione 1', 'pressione 2', 'pressione 3', 'pressione 4', 'pressione 9', 'pressione 0', 'pressione asterisco',
    'pressione cerquilha', 'pressione a tecla', 'pressione jogo da velha', 'pressione sustenido', 'aperte a tecla', 'aperte um', 'aperte 1',
    'para continuar em portugues', 'for english', 'para espanol', 'para ouvir novamente', 'para voltar ao menu', 'para retornar ao menu',
    'menu principal', 'menu de opcoes', 'ouca atentamente', 'ouca com atencao', 'as opcoes mudaram', 'nossas opcoes mudaram',
    'sua ligacao e muito importante', 'sua ligacao e importante para nos', 'agradecemos a sua ligacao', 'agradecemos sua ligacao',
    'bem vindo a central', 'bem vindo ao atendimento', 'seja bem vindo a central', 'central de atendimento', 'central de relacionamento',
    'nosso horario de atendimento', 'fora do horario de atendimento', 'fora do nosso horario', 'atendimento encerrado', 'todos os nossos atendentes',
    'todos os atendentes estao', 'nossos atendentes estao ocupados', 'sera atendido em instantes', 'sua posicao na fila', 'voce esta na posicao',
    'tempo estimado de espera', 'esta ligacao pode ser gravada', 'esta chamada pode ser gravada', 'esta ligacao sera gravada',
    'esta chamada sera gravada', 'ligacao sera gravada', 'chamada sera gravada', 'esta ligacao esta sendo gravada', 'esta chamada esta sendo gravada',
    'para fins de qualidade', 'protocolo de atendimento', 'anote o protocolo', 'pesquisa de satisfacao', 'avalie o atendimento',
    'por gentileza aguarde', 'por favor aguarde', 'por favor digite', 'por favor tecle', 'por favor pressione', 'atendimento eletronico',
    'atendimento virtual', 'sou a assistente virtual', 'sou o assistente virtual', 'sou a atendente virtual', 'sou um assistente virtual',
    'sou uma assistente virtual', 'mensagem gravada', 'esta e uma mensagem gravada', 'mensagem automatica', 'esta e uma mensagem automatica'
  ]
};

// Frases fortes que uma PESSOA também pode dizer (curtas, em 1ª pessoa ou soltas). Valem sozinhas só se não houver
// sinal de pessoa e a fala for longa o bastante.
const AMBIGUOUS = new Set([
  'foi alterado', 'codigo de area', 'esta desligado', 'permaneca na linha', 'continue na linha', 'aguarde na linha', 'por favor aguarde',
  'por favor digite', 'por favor tecle', 'por favor pressione', 'tecle um', 'digite um', 'o assinante', 'sem saldo', 'sem creditos',
  'fora de servico', 'chamada bloqueada', 'nao pode atender', 'nao podem atender', 'ligaremos de volta', 'retornaremos sua ligacao',
  'entraremos em contato assim que possivel', 'assim que possivel retornaremos', 'confira o numero', 'verifique o numero',
  'o numero que voce chamou', 'esta ligacao pode ser gravada', 'esta chamada pode ser gravada', 'esta ligacao sera gravada',
  'esta chamada sera gravada', 'ligacao sera gravada', 'chamada sera gravada', 'esta ligacao esta sendo gravada', 'esta chamada esta sendo gravada',
  'nao esta disponivel agora', 'nao esta disponivel no momento', 'nao se encontra disponivel', 'tente novamente mais tarde', 'ligue novamente mais tarde',
  'aguarde o sinal', 'central de atendimento', 'atendimento virtual', 'atendimento eletronico'
]);

// ---- FRACAS: só somam em fala longa
const WEAK = [
  'no momento', 'nao estou', 'nao estamos', 'indisponivel', 'mensagem', 'recado', 'gravada', 'gravacao', 'bip', 'bipe', 'beep', 'sinal',
  'tecla', 'pressione', 'tecle', 'digite', 'aguarde', 'retornar', 'retornaremos', 'retornarei', 'ligacao', 'chamada', 'por favor', 'opcao',
  'opcoes', 'atendimento', 'atendente', 'protocolo', 'informe', 'disponivel', 'horario', 'automatico', 'automatica', 'virtual', 'assistente',
  'motivo', 'assunto', 'contato', 'mais tarde'
];

// Sinais de pessoa de verdade
const HUMAN_SIGNS = [
  /^(alo|ola|oi|pois nao|pois pode|sim|bom dia|boa tarde|boa noite|quem fala|quem e|diga|pode falar|fala|opa|pronto|e ai)\b/,
  /\b(quem (e|fala|esta falando|ta falando)|de onde (fala|e)|do que se trata|o que (voce|vc) quer|com quem|nao entendi|como assim|nao conheco|numero errado|nao quero|nao tenho interesse|nao me ligue|para de ligar|estou ocupad|to ocupad|estou dirigindo|to dirigindo|me liga (depois|mais tarde|amanha)|liga (depois|mais tarde|amanha)|pode ligar (depois|mais tarde|amanha)|ligue (depois|mais tarde|amanha)|nao posso atender|nao estou podendo)\b/
];

const KIND_ORDER = ['invalido', 'caixa_postal', 'triagem', 'operadora', 'ura'];

function has(norm, phrase) {
  return ` ${norm} `.includes(` ${phrase} `);
}

function strongHits(norm) {
  const hits = [];
  for (const kind of KIND_ORDER) for (const p of STRONG[kind]) if (has(norm, p)) hits.push({ kind, phrase: p });
  return hits;
}

function weakCount(norm) {
  let n = 0;
  for (const w of WEAK) if (has(norm, w)) n += 1;
  return n;
}

const NONE = Object.freeze({ isMachine: false, kind: null, outcome: null, reason: '', hits: [] });

function verdict(kind, reason, hits = []) {
  return { isMachine: true, kind, outcome: kind === 'invalido' ? 'numero_errado' : 'caixa_postal', reason, hits };
}

/** Classifica UMA fala do cliente. turnIndex = 0 para a primeira fala da ligação. */
function classifyUtterance(text, { turnIndex = 0 } = {}) {
  const norm = normalize(text);
  if (!norm) return NONE;
  const words = norm.split(' ').filter(Boolean);
  const human = HUMAN_SIGNS.some((re) => re.test(norm));
  const hits = strongHits(norm);

  if (hits.length) {
    const solid = hits.filter((h) => !AMBIGUOUS.has(h.phrase));
    // 1+ frase sólida = máquina, exceto quando é fala muito curta de pessoa ("o assinante? quem?")
    if (solid.length && !(human && words.length <= 5)) {
      const counts = {};
      for (const h of solid) counts[h.kind] = (counts[h.kind] || 0) + 1;
      const kind = KIND_ORDER.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
      return verdict(kind, `frase de ${kind}: "${solid[0].phrase}"`, solid.map((h) => h.phrase).slice(0, 5));
    }
    // só frases ambíguas: precisa de 2 delas, ou 1 + fala longa/fracas, e nenhum sinal de pessoa
    if (!human) {
      const amb = hits.length;
      if (amb >= 2 || (words.length >= 9 && weakCount(norm) >= 2)) {
        return verdict(hits[0].kind, `frases típicas de gravação: "${hits[0].phrase}"`, hits.map((h) => h.phrase).slice(0, 5));
      }
    }
    return NONE;
  }

  if (human) return NONE;
  // monólogo longo logo no início (pessoa diz "alô"; gravação fala parágrafo)
  if (turnIndex <= 1 && words.length >= 28 && weakCount(norm) >= 3) {
    return verdict('ura', `monólogo de ${words.length} palavras logo no início`);
  }
  if (words.length >= 10 && weakCount(norm) >= 5) return verdict('ura', 'várias expressões típicas de gravação');
  return NONE;
}

/**
 * Analisa as últimas falas do cliente juntas (a pausa do detector de silêncio parte frases de gravação em pedaços)
 * e também detecta gravação em loop (mesma fala repetida).
 */
function classifyConversation(leadTurns, { max = 4 } = {}) {
  const texts = (leadTurns || []).map((t) => (typeof t === 'string' ? t : t?.text)).filter(Boolean).slice(-max);
  if (!texts.length) return NONE;
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const r = classifyUtterance(texts[i], { turnIndex: i });
    if (r.isMachine) return r;
  }
  if (texts.length > 1) {
    const joined = classifyUtterance(texts.join(' . '), { turnIndex: 0 });
    if (joined.isMachine) return joined;
    const last = normalize(texts[texts.length - 1]);
    const prev = normalize(texts[texts.length - 2]);
    if (last.split(' ').length >= 6 && prev && (last === prev || last.includes(prev) || prev.includes(last))) {
      return verdict('ura', 'a mesma fala se repetindo (gravação em loop)');
    }
  }
  return NONE;
}

const LABEL = {
  caixa_postal: 'Caixa postal / secretária eletrônica',
  operadora: 'Aviso da operadora',
  triagem: 'Triagem de chamadas (assistente do celular)',
  invalido: 'Número inexistente / errado',
  ura: 'Atendimento automático (URA)'
};

/** Interpreta "AnsweredBy" (Twilio/Telnyx/Jambonz) e "AMDSTATUS" (Asterisk). "unknown"/"human" = trata como pessoa. */
function isMachineAnsweredBy(value) {
  const v = String(value || '').toLowerCase();
  if (!v) return false;
  if (v.startsWith('machine')) return true; // machine_start, machine_end_beep, machine_end_silence, machine_end_other
  return ['fax', 'answering_machine', 'voicemail', 'not_sure_machine'].includes(v);
}

function describe(kind) {
  return LABEL[kind] || LABEL.caixa_postal;
}

module.exports = { normalize, classifyUtterance, classifyConversation, isMachineAnsweredBy, describe, LABEL, STRONG };
