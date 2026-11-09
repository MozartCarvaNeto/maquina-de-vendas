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
  const save = (patchBody) => run(() => api.put('/pbx/admin/did-settings', patchBody), '✅ Salvo');
  const edit = async (d) => {
    const number = window.prompt('Número (somente dígitos, com DDI):', d.number);
    if (number === null) return;
    const label2 = window.prompt('Observação:', d.label || '');
    if (label2 === null) return;
    const fee = window.prompt('Mensalidade deste número em R$ (vazio = usar o padrão; 0 = grátis):', d.monthlyFeeBrl ?? '');
    if (fee === null) return;
    run(() => api.put(`/pbx/admin/dids/${d.id}`, { number, label: label2, monthlyFeeBrl: fee === '' ? null : fee }), '✅ Número atualizado');
  };
  const history = async (d) => {
    try {
      const r = (await api.get(`/pbx/admin/dids/${d.id}/history`)).data;
      window.alert(r.length ? r.map((x) => `${new Date(x.at).toLocaleDateString('pt-BR')}  R$ ${Math.abs(x.amountBrl).toFixed(2)}`).join('\n') : 'Nenhuma cobrança ainda.');
    } catch (e) { flash(`❌ ${errText(e)}`); }
  };
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

      <h4>3. Regras: atribuição automática e mensalidade</h4>
      <label>
        <input type="checkbox" checked={data.settings.auto} onChange={(e) => save({ auto: e.target.checked })} />
        {' '}Atribuição automática: entrega um número livre a todo cliente ativo (com telefonia no plano) que ainda não tem número. Roda sozinha a cada 10 minutos, sem o cliente abrir nada.
      </label>
      <label>Quantidade por cliente: <input type="number" min={1} max={10} style={{ width: 70 }} value={data.settings.count} onChange={(e) => setData({ ...data, settings: { ...data.settings, count: e.target.value } })} onBlur={() => save({ count: data.settings.count })} /></label>
      <label>
        <input type="checkbox" checked={data.settings.billing} onChange={(e) => save({ billing: e.target.checked })} />
        {' '}Cobrar mensalidade dos números (debita do saldo do cliente; só vale para quem tem carteira ligada).
      </label>
      <div className="pbx-row">
        <label>Mensalidade padrão (R$): <input type="number" min={0} step="0.01" style={{ width: 90 }} value={data.settings.feeBrl} onChange={(e) => setData({ ...data, settings: { ...data.settings, feeBrl: e.target.value } })} onBlur={() => save({ feeBrl: data.settings.feeBrl })} /></label>
        <label>Dias de carência sem saldo: <input type="number" min={0} max={60} style={{ width: 70 }} value={data.settings.graceDays} onChange={(e) => setData({ ...data, settings: { ...data.settings, graceDays: e.target.value } })} onBlur={() => save({ graceDays: data.settings.graceDays })} /></label>
        <label><input type="checkbox" checked={data.settings.autoSuspend} onChange={(e) => save({ autoSuspend: e.target.checked })} /> Suspender o número depois da carência (volta sozinho quando houver saldo)</label>
      </div>
      <div className="pbx-row">
        <button type="button" className="btn-secondary-small" onClick={() => run(() => api.post('/pbx/admin/did-run', { what: 'sweep' }), (r) => `✅ Atribuição rodada: ${r.assigned.length} número(s) entregue(s)`)}>Rodar atribuição agora</button>
        <button type="button" className="btn-secondary-small" onClick={() => run(() => api.post('/pbx/admin/did-run', { what: 'billing' }), (r) => `✅ Cobrança rodada: ${r.charged} cobrada(s), ${r.failed} sem saldo, ${r.suspended.length} suspensa(s), ${r.unsuspended.length} reativada(s)`)}>Rodar cobrança agora</button>
      </div>

      <h4>Números ({data.dids.length})</h4>
      <div className="pbx-row">
        {['todos', 'livres', 'atribuidos'].map((f) => <button key={f} type="button" className={filter === f ? 'btn-primary' : 'btn-secondary-small'} onClick={() => setFilter(f)}>{f === 'todos' ? 'Todos' : f === 'livres' ? 'Livres' : 'Atribuídos'}</button>)}
      </div>
      <table className="pbx-table">
        <thead><tr><th /><th>Número</th><th>Observação</th><th>Cliente</th><th>Mensalidade</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {shown.map((d) => (
            <tr key={d.id}>
              <td><input type="checkbox" checked={!!picked[d.id]} onChange={(e) => setPicked({ ...picked, [d.id]: e.target.checked })} /></td>
              <td>{fmt(d.number)}</td><td>{d.label || '—'}</td><td>{d.accountName || <em>livre</em>}</td>
              <td>{d.accountId ? (d.monthlyFeeBrl === null || d.monthlyFeeBrl === undefined ? `padrão (R$ ${Number(data.settings.feeBrl).toFixed(2)})` : `R$ ${Number(d.monthlyFeeBrl).toFixed(2)}`) : '—'}{d.nextBillAt ? <small> · vence {new Date(d.nextBillAt).toLocaleDateString('pt-BR')}</small> : null}</td>
              <td>{d.suspendedAt ? '⛔ suspenso' : d.overdueSince ? '⚠️ sem saldo' : d.accountId ? '✅ ativo' : '—'}</td>
              <td>
                <button type="button" className="btn-secondary-small" onClick={() => edit(d)}>Editar</button>{' '}
                {d.accountId && <button type="button" className="btn-secondary-small" onClick={() => run(() => api.put(`/pbx/admin/dids/${d.id}`, { suspended: !d.suspendedAt }), d.suspendedAt ? '✅ Reativado' : '✅ Suspenso')}>{d.suspendedAt ? 'Reativar' : 'Suspender'}</button>}{' '}
                {d.accountId && <button type="button" className="btn-secondary-small" onClick={() => history(d)}>Cobranças</button>}{' '}
                <button type="button" className="btn-secondary-small" onClick={() => window.confirm('Apagar este número do estoque?') && run(() => api.delete(`/pbx/admin/dids/${d.id}`), '✅ Apagado')}>Apagar</button>
              </td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={7}>Nenhum número.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
