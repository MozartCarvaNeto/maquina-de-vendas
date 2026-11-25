// backend/src/services/whatsapp/chromiumGuard.js
//
// Ferramentas para o servidor NÃO acumular navegadores (Chromium) do WhatsApp na memória:
//  - lista os Chromium de sessão que estão rodando (e quanta memória cada sessão usa);
//  - lê a memória realmente disponível do servidor (para recusar novas conexões antes de travar tudo).
// Só funciona em Linux (servidor). No Windows (uso local) devolve listas vazias e não bloqueia nada.
const fs = require('fs');
const { execFile } = require('child_process');

const SESSION_RE = /session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Texto do `ps -eo pid=,rss=,args=` -> [{ pid, rssMb, sessionId }] só dos Chromium DESTE sistema. */
function parsePs(output, sessionsRoot) {
  const found = [];
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[3];
    if (!/chrom/i.test(args) || !args.includes(sessionsRoot)) continue;
    const s = args.match(SESSION_RE);
    if (!s) continue;
    found.push({ pid: Number(m[1]), rssMb: Number(m[2]) / 1024, sessionId: s[1].toLowerCase() });
  }
  return found;
}

function listChromium(sessionsRoot) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve([]);
    try {
      execFile('ps', ['-eo', 'pid=,rss=,args='], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
        resolve(err ? [] : parsePs(out, sessionsRoot));
      });
    } catch {
      resolve([]);
    }
  });
}

/** Memória que o sistema consegue liberar sem usar swap (MemAvailable), em MB. null = não sei medir. */
function memoryAvailableMb(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const m = readFile('/proc/meminfo').match(/^MemAvailable:\s+(\d+)\s*kB/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

module.exports = { parsePs, listChromium, memoryAvailableMb, SESSION_RE };
