// frontend/src/components/pbx/PbxServidor.jsx
// Só administrador: onde o Asterisk está (neste servidor ou em outro, por SSH).
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';

const errText = (e) => e.response?.data?.error || e.message || 'Erro';

export default function PbxServidor({ flash: flashProp }) {
  const ref = useRef(flashProp);
  ref.current = flashProp;
  const flash = useCallback((t) => ref.current(t), []);
  const [f, setF] = useState(null);
  const [key, setKey] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setF((await api.get('/pbx/admin/asterisk-host')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  if (!f) return <div className="card"><p className="hint-text">Carregando…</p></div>;
  const set = (k, v) => setF({ ...f, [k]: v });
  const remote = f.mode === 'ssh';

  const save = async () => {
    setBusy(true);
    try {
      const body = { mode: f.mode, host: f.host, port: f.port, user: f.user, hookBase: f.hookBase === f.hookBaseDefault ? '' : f.hookBase, audioHost: f.audioHost, confDir: f.confDir, spoolDir: f.spoolDir, soundsDir: f.soundsDir, recordingsDir: f.recordingsDir };
      if (key.trim()) body.secret = key;
      setF({ ...(await api.put('/pbx/admin/asterisk-host', body)).data, hookBaseDefault: f.hookBaseDefault, audioSocketPort: f.audioSocketPort });
      setKey('');
      flash('✅ Salvo. Se mudou entre "este servidor" e "outro servidor", reinicie o backend uma vez (a ponte da IA muda de endereço).');
    } catch (e) { flash(`❌ ${errText(e)}`); }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try { setResult((await api.post('/pbx/admin/asterisk-host/test')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
    setBusy(false);
  };
  const applyAll = async () => {
    setBusy(true);
    try { const r = (await api.post('/pbx/admin/apply-all')).data; flash(`✅ Configuração aplicada em ${r.ok} de ${r.total} conta(s)${r.ok < r.total ? ` — falhou: ${r.results.filter((x) => !x.ok).map((x) => x.error).slice(0, 2).join('; ')}` : ''}`); } catch (e) { flash(`❌ ${errText(e)}`); }
    setBusy(false);
  };

  return (
    <div className="card">
      <h3>🖥️ Servidor do Asterisk</h3>
      <p className="hint-text">Diga ao sistema onde o Asterisk está. Com o Asterisk em outro servidor, o sistema grava a configuração, os áudios e as ligações lá por SSH — você não precisa mais clicar em "Aplicar no Asterisk" em cada conta.</p>
      <div className="pbx-row">
        <label><input type="radio" checked={!remote} onChange={() => set('mode', 'local')} /> Neste mesmo servidor</label>
        <label><input type="radio" checked={remote} onChange={() => set('mode', 'ssh')} /> Em outro servidor (SSH)</label>
      </div>
      {remote && (
        <>
          <div className="pbx-row">
            <input placeholder="IP ou nome do servidor do Asterisk" value={f.host || ''} onChange={(e) => set('host', e.target.value)} />
            <input style={{ width: 90 }} placeholder="Porta" value={f.port || ''} onChange={(e) => set('port', e.target.value)} />
            <input style={{ width: 140 }} placeholder="Usuário" value={f.user || ''} onChange={(e) => set('user', e.target.value)} />
          </div>
          <label>Chave privada SSH {f.hasKey ? <small>(já salva {f.keyHint} — deixe em branco para manter)</small> : null}</label>
          <textarea rows={4} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'} value={key} onChange={(e) => setKey(e.target.value)} />
          <p className="hint-text">Gere um par de chaves, coloque a pública em ~/.ssh/authorized_keys do usuário no servidor do Asterisk e cole aqui a privada. O usuário precisa poder rodar "asterisk -rx" e gravar nas pastas abaixo.</p>
          <label>Endereço de retorno (como o Asterisk enxerga este sistema)</label>
          <input value={f.hookBase || ''} placeholder={f.hookBaseDefault} onChange={(e) => set('hookBase', e.target.value)} />
          <label>IP/nome deste sistema para a ponte da IA (AudioSocket, porta {f.audioSocketPort})</label>
          <input value={f.audioHost || ''} placeholder="IP deste servidor visto pelo Asterisk" onChange={(e) => set('audioHost', e.target.value)} />
          <p className="hint-text">⚠️ A ponte da IA aceita só conexões vindas do IP do Asterisk, mas libere também no firewall a porta {f.audioSocketPort} apenas para esse IP. Não abra para a internet.</p>
        </>
      )}
      <details>
        <summary>Pastas no servidor do Asterisk</summary>
        {[['confDir', 'Configuração'], ['spoolDir', 'Ligações (outgoing)'], ['soundsDir', 'Áudios'], ['recordingsDir', 'Gravações']].map(([k, l]) => (
          <div key={k}><label>{l}</label><input value={f[k] || ''} onChange={(e) => set(k, e.target.value)} /></div>
        ))}
      </details>
      <div className="pbx-row">
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>Salvar</button>
        <button type="button" className="btn-secondary-small" disabled={busy} onClick={test}>Testar conexão</button>
        <button type="button" className="btn-secondary-small" disabled={busy} onClick={applyAll}>Aplicar configuração em todas as contas</button>
      </div>
      {result && (
        <ul className="hint-text">
          {result.steps.map((s) => <li key={s.name}>{s.ok ? '✅' : '❌'} {s.name}{s.detail ? ` — ${s.detail}` : ''}</li>)}
        </ul>
      )}
    </div>
  );
}
