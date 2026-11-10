// frontend/src/components/admin/RevenuePanel.jsx — receita recorrente, inadimplência, cancelamentos e notas fiscais
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import '../account/Account.css';

const money = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const thisMonth = () => new Date().toISOString().slice(0, 7);

function Kpi({ label, value, hint }) { return <div className="acc-kpi"><span>{label}</span><strong>{value}</strong>{hint && <div className="acc-muted">{hint}</div>}</div>; }

function FiscalList() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState({});
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api.get('/admin/fiscal', { params: { month } }).then((r) => setData(r.data)).catch((e) => setMsg({ error: true, text: e.response?.data?.error || 'Erro ao carregar.' })), [month]);
  useEffect(() => { load(); }, [load]);

  async function csv() {
    try {
      const r = await api.get('/admin/fiscal', { params: { month, format: 'csv' }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = `faturamento-${month}.csv`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setMsg({ error: true, text: 'Não foi possível baixar a planilha.' }); }
  }
  async function mark(row) {
    const v = edit[row.kind + row.id] || {};
    try { await api.put(`/admin/fiscal/${row.kind}/${row.id}`, { nfseNumber: v.nfseNumber ?? row.nfseNumber, nfseUrl: v.nfseUrl ?? row.nfseUrl }); setMsg({ text: 'Nota registrada.' }); load(); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao salvar.' }); }
  }
  const set = (row, k) => (e) => setEdit({ ...edit, [row.kind + row.id]: { ...(edit[row.kind + row.id] || {}), [k]: e.target.value } });

  return (
    <section className="acc-card">
      <h3>Notas fiscais do mês</h3>
      <p className="acc-muted">Lista de tudo que foi pago. Baixe a planilha para seu contador emitir as notas e depois registre o número aqui; o cliente vê no recibo dele.</p>
      <div className="acc-row">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês" />
        <button className="btn-outline" onClick={csv}>Baixar planilha (CSV)</button>
        {data && <span className="acc-muted">{money(data.total)} · {data.pendingInvoice} sem nota</span>}
      </div>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
      <div className="acc-table-wrap">
        <table className="acc-table">
          <thead><tr><th>Data</th><th>Cliente</th><th>Tipo</th><th>Valor</th><th>Dados</th><th>Nº da nota</th><th>Link</th><th /></tr></thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={r.kind + r.id}>
                <td>{new Date(r.paidAt).toLocaleDateString('pt-BR')}</td><td>{r.customer}<div className="acc-muted">{r.taxId}</div></td><td>{r.kind}</td><td>{money(r.amount)}</td>
                <td>{r.dataOk ? <span className="acc-ok">completos</span> : <span className="acc-warn">faltam CPF/CNPJ</span>}</td>
                <td><input defaultValue={r.nfseNumber} onChange={set(r, 'nfseNumber')} style={{ width: 90 }} aria-label="Número da nota" /></td>
                <td><input defaultValue={r.nfseUrl} onChange={set(r, 'nfseUrl')} style={{ width: 140 }} placeholder="https://" aria-label="Link da nota" /></td>
                <td><button className="btn-outline" onClick={() => mark(r)}>Salvar</button></td>
              </tr>
            ))}
            {data && data.rows.length === 0 && <tr><td colSpan={8} className="acc-muted">Nenhum pagamento neste mês.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function RevenuePanel() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/admin/revenue').then((r) => setD(r.data)).catch((e) => setError(e.response?.data?.error || 'Erro ao carregar.')); }, []);
  if (error) return <div className="acc-msg is-error">{error}</div>;
  if (!d) return <p>Carregando…</p>;
  const max = Math.max(1, ...d.revenue.map((r) => r.total));
  return (
    <div>
      <div className="acc-kpis">
        <Kpi label="Receita recorrente (MRR)" value={money(d.mrr)} hint={`${money(d.arr)} por ano`} />
        <Kpi label="Clientes pagantes" value={d.clients.paying} hint={`ticket médio ${money(d.arpu)}`} />
        <Kpi label="Em teste grátis" value={d.clients.trial} />
        <Kpi label="Inadimplentes" value={d.delinquent.count} hint={`${money(d.delinquent.monthlyValue)} por mês em risco`} />
        <Kpi label="Cancelamentos (30 dias)" value={d.churn.last30} hint={`${d.churn.ratePct}% da base`} />
        <Kpi label="Novos (30 dias)" value={d.clients.newLast30} hint={`${d.clients.pending} aguardando aprovação`} />
      </div>

      <section className="acc-card">
        <h3>Receita por mês</h3>
        <p className="acc-muted">Planos pagos mais recargas de saldo. O lucro do uso de telefonia está na aba Gateway, em Lucro.</p>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Mês</th><th>Planos</th><th>Recargas</th><th>Total</th><th style={{ width: '30%' }} /></tr></thead>
            <tbody>{d.revenue.map((r) => (
              <tr key={r.month}><td>{r.month}</td><td>{money(r.plans)}</td><td>{money(r.topups)}</td><td><strong>{money(r.total)}</strong></td><td><div className="acc-bar"><div style={{ width: `${(r.total / max) * 100}%` }} /></div></td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="acc-card">
        <h3>Receita por plano</h3>
        <div className="acc-table-wrap"><table className="acc-table"><thead><tr><th>Plano</th><th>Clientes</th><th>MRR</th></tr></thead><tbody>
          {d.byPlan.map((p) => <tr key={p.plan}><td>{p.plan}</td><td>{p.clients}</td><td>{money(p.mrr)}</td></tr>)}
          {d.byPlan.length === 0 && <tr><td colSpan={3} className="acc-muted">Nenhum cliente com plano pago ainda.</td></tr>}
        </tbody></table></div>
      </section>

      <section className="acc-card">
        <h3>Inadimplência e vencimentos</h3>
        <div className="acc-table-wrap"><table className="acc-table"><thead><tr><th>Cliente</th><th>E-mail</th><th>Plano</th><th>Situação</th></tr></thead><tbody>
          {d.delinquent.accounts.map((a) => <tr key={'d' + a.id}><td>{a.name}</td><td>{a.owner}</td><td>{a.plan} ({money(a.value)}/mês)</td><td className={a.inGrace ? 'acc-warn' : 'acc-bad'}>{a.inGrace ? 'Vencido, em carência' : 'Vencido'} há {a.daysOverdue} dia(s)</td></tr>)}
          {d.atRisk.map((a) => <tr key={'r' + a.id}><td>{a.name}</td><td>{a.owner}</td><td>{a.plan}</td><td className="acc-warn">{a.trial ? 'Teste termina' : 'Vence'} em {a.daysLeft} dia(s)</td></tr>)}
          {d.delinquent.accounts.length + d.atRisk.length === 0 && <tr><td colSpan={4} className="acc-muted">Tudo em dia.</td></tr>}
        </tbody></table></div>
      </section>

      <FiscalList />
    </div>
  );
}
