// backend/src/services/pbx/markup.js
// A conversa da IA é escrita em TwiML. Aqui lemos esse TwiML e viramos uma lista de passos simples
// que a ponte do Asterisk sabe executar: falar, ouvir, transferir, desligar.
function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attrsOf(raw) {
  const out = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw || ''))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function parseSay(raw, attrsRaw, interruptible) {
  const a = attrsOf(attrsRaw);
  const tts = /^gemini:([^|]*)\|/i.exec(a['data-tts'] || '');
  return {
    type: 'say',
    text: unescapeXml(raw).replace(/<[^>]+>/g, '').trim(),
    voice: tts ? `gemini:${tts[1] || 'Kore'}` : a['data-voice'] || a.voice || null,
    language: a.language || 'pt-BR',
    interruptible
  };
}

/** @returns {Array<{type:'say'|'gather'|'dial'|'hangup'|'play'|'redirect', ...}>} */
function parseMarkup(xml) {
  const steps = [];
  const body = String(xml || '').replace(/^[\s\S]*?<Response[^>]*>/, '').replace(/<\/Response>[\s\S]*$/, '');
  const re = /<Say\b([^>]*)>([\s\S]*?)<\/Say>|<Play\b[^>]*>([\s\S]*?)<\/Play>|<Gather\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Gather>)|<Dial\b([^>]*)>([\s\S]*?)<\/Dial>|<Hangup\s*\/?>|<Redirect\b[^>]*>([\s\S]*?)<\/Redirect>|<Pause\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0].startsWith('<Say')) steps.push(parseSay(m[2], m[1], false));
    else if (m[0].startsWith('<Play')) steps.push({ type: 'play', url: unescapeXml(m[3]).trim() });
    else if (m[0].startsWith('<Gather')) {
      const a = attrsOf(m[4]);
      const prompts = [];
      const inner = m[5] || '';
      const sre = /<Say\b([^>]*)>([\s\S]*?)<\/Say>/g;
      let s;
      while ((s = sre.exec(inner))) prompts.push(parseSay(s[2], s[1], true));
      steps.push({
        type: 'gather',
        prompts,
        timeout: Math.max(2, parseInt(a.timeout || '6', 10) || 6),
        language: a.language || 'pt-BR'
      });
    } else if (m[0].startsWith('<Dial')) {
      const num = /<Number[^>]*>([\s\S]*?)<\/Number>/.exec(m[7] || '');
      const a = attrsOf(m[6]);
      steps.push({ type: 'dial', number: num ? unescapeXml(num[1]).trim() : '', timeout: parseInt(a.timeout || '25', 10) || 25 });
    } else if (m[0].startsWith('<Hangup')) steps.push({ type: 'hangup' });
    else if (m[0].startsWith('<Redirect')) steps.push({ type: 'redirect', url: unescapeXml(m[8]).trim() });
    else if (m[0].startsWith('<Pause')) steps.push({ type: 'pause', seconds: parseInt(attrsOf(m[9]).length || '1', 10) || 1 });
  }
  return steps;
}

module.exports = { parseMarkup };
