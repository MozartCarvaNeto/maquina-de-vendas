// frontend/src/components/pbx/PbxNumeros.jsx
// Tela do administrador da plataforma: estoque de números (DID) e atribuição aos clientes.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';

const errText = (e) => e.response?.data?.error || e.message || 'Erro';
const fmt = (n) => (n.length > 11 ? `+${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4)}` : n);

export default function PbxNumeros({ flash: flashProp }) {
  const ref = useRef(flashProp);
  ref.current = flashProp;
  const flash = useCallback((t) => ref.current(t), []);
  const [data, setData] = useState(null);
  const [newNumbers, setNewNumbers] = useState('');
  const [label, setLabel] = useState('');
  const [picked, setPicked] = useState({});
  const [client, setClient] = useState('');
  const [lines, setLines] = useState('');
  const [filter, setFilter] = useState('todos');

  const load = useCallback(async () => {
    try { setData((await api.get('/pbx/admin/dids')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const ids = Object.keys(picked).filter((k) => picked[k]);
  const run = async (fn, ok) => {
    try { const r = await fn(); flash(typeof ok === 'function' ? ok(r?.data) : ok); setPicked({}); load(); } catch (e) { flash(`❌ ${errText(e)}`); }
  };

  if (!data) return <div className="card"><p className="hint-text">Carregando…</p></div>;
  const shown = data.dids.filter((d) => (filter === 'livres' ? !d.accountId : filter === 'atribuidos' ? d.accountId : true));

  return (
    <div className="card">
      <h3>📞 Números da plataforma (DID)</h3>
      <p className="hint-text">
        Cadastre aqui os números que você contratou no tronco SIP e entregue aos clientes. A ligação que entrar em um número vai para a conta
        do cliente dono dele (rotas, URA, filas, IA). O número também vira "número de discagem" do cliente (Linhas), usado como identificador nas ligações dele.
        Depois de atribuir, o sistema já grava a configuração no Asterisk.
      </p>

      <h4>1. Cadastrar números no estoque</h4>
      <textarea rows={3} placeholder={'Um por linha ou separados por vírgula\n551130001234\n5511930001235'} value={newNumbers} onChange={(e) => setNewNumbers(e.target.value)} />
      <div className="pbx-row">
        <input placeholder="Observação (ex.: Operadora X, 30 canais)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className="btn-primary" onClick={() => run(() => api.post('/pbx/admin/dids', { numbers: newNumbers, label }), (r) => `✅ ${r.added} número(s) cadastrado(s)${r.skipped?.length ? ` · ${r.skipped.length} ignorado(s): ${r.skipped.slice(0, 3).join('; ')}` : ''}`).then(() => setNewNumbers(''))}>Cadastrar</button>
      </div>

      <h4>2. Atribuir</h4>
      <div className="pbx-row">
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">— escolha o cliente —</option>
          {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` (${a.email})` : ''}</option>)}
        </select>
        <button type="button" className="btn-primary" disabled={!client || !ids.length} onClick={() => run(() => api.post('/pbx/admin/dids/assign', { ids, accountId: client }), (r) => `✅ ${r.done} atribuído(s)${r.errors?.length ? ` · erros: ${r.errors.join('; ')}` : ''}`)}>Atribuir {ids.length || ''} marcado(s)</button>
        <button type="button" className="btn-secondary-small" disabled={!ids.length} onClick={() => window.confirm('Tirar os números marcados dos clientes?') && run(() => api.post('/pbx/admin/dids/unassign', { ids }), '✅ Números devolvidos ao estoque')}>Devolver ao estoque</button>
      </div>
      <details>
        <summary>Atribuir vários números a vários clientes de uma vez</summary>
        <textarea rows={4} placeholder={'Uma linha por número: número;e-mail do cliente\n551130001234;cliente1@empresa.com\n551130001235;cliente2@empresa.com'} value={lines} onChange={(e) => setLines(e.target.value)} />
        <button type="button" className="btn-secondary-small" onClick={() => run(() => api.post('/pbx/admin/dids/assign', { lines }), (r) => `✅ ${r.done} atribuído(s)${r.errors?.length ? ` · erros: ${r.errors.join('; ')}` : ''}`).then(() => setLines(''))}>Atribuir lista</button>
      </details>

      <h4>3. Atribuição automática</h4>
      <label>
        <input type="checkbox" checked={data.settings.auto} onChange={(e) => run(() => api.put('/pbx/admin/did-settings', { auto: e.target.checked, count: data.settings.count }), '✅ Salvo')} />
        {' '}Entregar automaticamente um número livre ao cliente que tem telefonia no plano e ainda não tem número (na primeira vez que abrir a Telefonia PBX).
      </label>
      <label>Quantidade por cliente: <input type="number" min={1} max={10} style={{ width: 70 }} value={data.settings.count} onChange={(e) => setData({ ...data, settings: { ...data.settings, count: e.target.value } })} onBlur={() => run(() => api.put('/pbx/admin/did-settings', { auto: data.settings.auto, count: data.settings.count }), '✅ Salvo')} /></label>

      <h4>Números ({data.dids.length})</h4>
      <div className="pbx-row">
        {['todos', 'livres', 'atribuidos'].map((f) => <button key={f} type="button" className={filter === f ? 'btn-primary' : 'btn-secondary-small'} onClick={() => setFilter(f)}>{f === 'todos' ? 'Todos' : f === 'livres' ? 'Livres' : 'Atribuídos'}</button>)}
      </div>
      <table className="pbx-table">
        <thead><tr><th /><th>Número</th><th>Observação</th><th>Cliente</th><th /></tr></thead>
        <tbody>
          {shown.map((d) => (
            <tr key={d.id}>
              <td><input type="checkbox" checked={!!picked[d.id]} onChange={(e) => setPicked({ ...picked, [d.id]: e.target.checked })} /></td>
              <td>{fmt(d.number)}</td><td>{d.label || '—'}</td><td>{d.accountName || <em>livre</em>}</td>
              <td><button type="button" className="btn-secondary-small" onClick={() => window.confirm('Apagar este número do estoque?') && run(() => api.delete(`/pbx/admin/dids/${d.id}`), '✅ Apagado')}>Apagar</button></td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={5}>Nenhum número.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
