// backend/src/services/telephony/markupAdapters.js
//
// A conversa da IA é montada em TwiML (o "idioma" da Twilio). Para usar OUTRAS operadoras sem reescrever
// a conversa, este arquivo traduz o que já geramos:
//   - "telnyx":  TeXML (quase igual ao TwiML; só ajusta o reconhecimento de fala e os endereços)
//   - "jambonz": JSON de verbos (usado com operadoras SIP / troncos SIP nacionais via Jambonz)
// E também traduz o que as operadoras enviam de volta (status e fala do cliente) para os nomes que o
// sistema já entende. A Twilio continua exatamente como era (nenhuma tradução).

const DIALECTS = ['twiml', 'texml', 'jambonz'];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Acrescenta ?dialect=... nos endereços de retorno (webhook) do TwiML, para sabermos como responder. */
function withDialect(xml, dialect) {
  if (!dialect || dialect === 'twiml') return xml;
  const add = (url) => `${url}${url.includes('?') ? '&amp;' : '?'}dialect=${dialect}`;
  return String(xml)
    .replace(/(\saction=")([^"]*\/api\/ai-calls\/webhook\/[^"]*)(")/g, (m, a, url, c) => `${a}${add(url)}${c}`)
    .replace(/(<Redirect\b[^>]*>)([^<]*\/api\/ai-calls\/webhook\/[^<]*)(<\/Redirect>)/g, (m, a, url, c) => `${a}${add(url)}${c}`);
}

// ---------------------------------------------------------------- TwiML -> TeXML (Telnyx)

/**
 * Ajustes para a Telnyx. O reconhecimento de fala dela usa outros parâmetros:
 *  - sem "actionOnEmptyResult" e "speechTimeout=auto" (a conversa já tem um <Redirect> logo após o <Gather>
 *    que trata o silêncio);
 *  - motor de transcrição configurável ("deepgram" ou "google").
 */
function twimlToTexml(xml, { sttEngine = 'deepgram' } = {}) {
  let out = withDialect(xml, 'texml');
  out = out.replace(/<Gather\b([^>]*)>/g, (m, attrs) => {
    let a = attrs.replace(/\sactionOnEmptyResult="[^"]*"/, '').replace(/\sspeechTimeout="[^"]*"/, ' speechTimeout="2"');
    const hints = (a.match(/\shints="([^"]*)"/) || [])[1];
    a = a.replace(/\shints="[^"]*"/, '');
    if (String(sttEngine).toLowerCase() === 'google') {
      a += ' transcriptionEngine="Google"';
    } else {
      a += ' transcriptionEngine="Deepgram" model="deepgram/nova-3"';
      if (hints) a += ` keyterms="${hints}"`;
    }
    return `<Gather${a}>`;
  });
  return out;
}

// ---------------------------------------------------------------- TwiML -> verbos Jambonz

function parseAttrs(raw) {
  const attrs = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

/** Lê o TwiML (só o subconjunto que nós mesmos geramos) e devolve uma árvore simples. */
function parseTwiml(xml) {
  const root = { name: 'root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tokenRe = /<(\/?)([A-Za-z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(xml))) {
    if (m[5] !== undefined) {
      stack[stack.length - 1].text += m[5];
      continue;
    }
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const node = { name, attrs: parseAttrs(rawAttrs), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root;
}

function nodeToVerb(node) {
  const text = decodeEntities(node.text).replace(/\s+/g, ' ').trim();
  switch (node.name) {
    case 'Say':
      return { verb: 'say', text };
    case 'Play':
      return { verb: 'play', url: text };
    case 'Pause':
      return { verb: 'pause', length: Number(node.attrs.length) || 1 };
    case 'Hangup':
      return { verb: 'hangup' };
    case 'Redirect':
      return null; // o "silêncio" é tratado pelo próprio gather (reason: timeout)
    case 'Gather': {
      const verb = {
        verb: 'gather',
        input: ['speech'],
        actionHook: node.attrs.action,
        timeout: Number(node.attrs.timeout) || 6,
        bargein: true,
        recognizer: {
          language: node.attrs.language || 'pt-BR',
          hints: String(node.attrs.hints || '').split(',').map((h) => h.trim()).filter(Boolean)
        }
      };
      const nestedPlay = node.children.find((c) => c.name === 'Play');
      const nestedSay = node.children.find((c) => c.name === 'Say');
      if (nestedPlay) verb.play = { url: decodeEntities(nestedPlay.text).trim() };
      else if (nestedSay) verb.say = { text: decodeEntities(nestedSay.text).replace(/\s+/g, ' ').trim() };
      return verb;
    }
    case 'Dial': {
      const numbers = node.children.filter((c) => c.name === 'Number').map((c) => decodeEntities(c.text).trim());
      return {
        verb: 'dial',
        actionHook: node.attrs.action,
        answerOnBridge: node.attrs.answerOnBridge === 'true',
        callerId: node.attrs.callerId,
        timeout: Number(node.attrs.timeout) || 25,
        target: numbers.map((number) => ({ type: 'phone', number }))
      };
    }
    default:
      return null;
  }
}

/** TwiML -> array de verbos do Jambonz. */
function twimlToJambonz(xml) {
  const tree = parseTwiml(String(xml || ''));
  const response = tree.children.find((c) => c.name === 'Response') || tree;
  return response.children.map(nodeToVerb).filter(Boolean);
}

// ---------------------------------------------------------------- respostas / pedidos

/** Converte o TwiML final para o formato que a operadora que fez o pedido espera. */
function convertResponse(xml, dialect, options = {}) {
  if (dialect === 'texml') return { type: 'text/xml', body: twimlToTexml(xml, options) };
  if (dialect === 'jambonz') return { type: 'application/json', body: JSON.stringify(twimlToJambonz(xml)) };
  return { type: 'text/xml', body: xml };
}

/**
 * Normaliza o corpo recebido: o Jambonz manda JSON com outros nomes; traduzimos para os nomes da Twilio
 * (CallSid, CallStatus, SpeechResult, DialCallStatus) que o resto do sistema já usa.
 */
function normalizeIncoming(body, dialect) {
  const b = body || {};
  if (dialect !== 'jambonz') return b;
  const statusMap = { trying: 'queued', 'early-media': 'ringing' };
  const alt = b.speech?.alternatives?.[0];
  return {
    ...b,
    CallSid: b.call_sid || b.CallSid,
    CallStatus: statusMap[b.call_status] || b.call_status || b.CallStatus,
    SpeechResult: alt?.transcript || b.SpeechResult,
    Confidence: alt?.confidence ?? b.Confidence,
    DialCallStatus: b.dial_call_status || b.DialCallStatus
  };
}

module.exports = { DIALECTS, withDialect, twimlToTexml, twimlToJambonz, convertResponse, normalizeIncoming, parseTwiml };
