// frontend/src/pages/Revendedor.jsx — painel do revendedor: clientes, tarifas e saldo
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import '../components/account/Account.css';

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const err = (e) => e.response?.data?.error || 'Erro';

export default function Revendedor() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState(null);
  const [f, setF] = useState({ companyName: '', ownerName: '', email: '', planId: '', days: '30' });
  const [creds, setCreds] = useState(null);
  const [edit, setEdit] = useState({});

  const load = useCallback(async () => {
    try { setD((await api.get('/reseller')).data); } catch (e) { setMsg({ error: true, text: err(e) }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    try { const { data } = await api.post('/reseller/clients', f); setCreds(data.credentials); setF({ companyName: '', ownerName: '', email: '', planId: '', days: '30' }); load(); } catch (x) { setMsg({ error: true, text: err(x) }); }
  }
  const E = (c) => edit[c.id] || { sms: c.rates.smsPerPartBrl, vo: c.rates.voiceOutPerMinBrl, vi: c.rates.voiceInPerMinBrl, add: '' };
  const setE = (c, patch) => setEdit({ ...edit, [c.id]: { ...E(c), ...patch } });

  async function saveRates(c) {
    const v = E(c);
    try { await api.put(`/reseller/clients/${c.id}/rates`, { smsPerPartBrl: v.sms, voiceOutPerMinBrl: v.vo, voiceInPerMinBrl: v.vi }); setMsg({ text: 'Tarifas salvas.' }); load(); } catch (x) { setMsg({ error: true, text: err(x) }); }
  }
  async function addCredit(c) {
    try { await api.post(`/reseller/clients/${c.id}/transfer`, { amountBrl: E(c).add }); setMsg({ text: 'Saldo adicionado ao cliente.' }); setE(c, { add: '' }); load(); } catch (x) { setMsg({ error: true, text: err(x) }); }
  }
  async function block(c, blocked) {
    try { await api.put(`/reseller/clients/${c.id}/status`, { blocked }); load(); } catch (x) { setMsg({ error: true, text: err(x) }); }
  }

  if (!d) return <div style={{ padding: 24 }}>{msg ? <div className="acc-msg is-error">{msg.text}</div> : 'Carregando…'}</div>;
  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1>🏪 Meus clientes (revenda)</h1>
      <p className="acc-muted">Seu custo de atacado — SMS: <strong>{brl(d.wholesale.smsPerPartBrl)}</strong>/parte · Ligação feita: <strong>{brl(d.wholesale.voiceOutPerMinBrl)}</strong>/min · recebida: <strong>{brl(d.wholesale.voiceInPerMinBrl)}</strong>/min. Seu saldo de atacado: <strong>{brl(d.wholesale.balanceBrl)}</strong>. Conforme seus clientes usam, o atacado é debitado desse saldo (recarregue em Gateway → Saldo); com saldo zerado, os clientes pausam. Você define o preço de venda de cada cliente, nunca abaixo do atacado.</p>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
      {creds && <div className="acc-msg">Cliente criado. Envie o acesso: <strong>{creds.email}</strong> / senha temporária <strong>{creds.password}</strong> (anote agora; ela não aparece de novo).</div>}

      <form className="acc-card" onSubmit={create}>
        <h3>Novo cliente{d.maxClients != null ? ` (${d.clients.length}/${d.maxClients})` : ''}</h3>
        <div className="acc-grid">
          <div><label htmlFor="rv-co">Empresa</label><input id="rv-co" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} /></div>
          <div><label htmlFor="rv-on">Nome do responsável</label><input id="rv-on" required value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></div>
          <div><label htmlFor="rv-em">E-mail</label><input id="rv-em" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><label htmlFor="rv-pl">Plano</label><select id="rv-pl" value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="">Sem plano (sem limites)</option>{d.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div><label htmlFor="rv-dy">Dias de acesso</label><input id="rv-dy" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></div>
        </div>
        <div className="acc-row"><button className="btn-primary" type="submit">Criar cliente</button></div>
      </form>

      <div className="acc-card">
        <h3>Clientes ({d.clients.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Cliente</th><th>Saldo</th><th>Preço SMS</th><th>Voz saída</th><th>Voz entrada</th><th>Adicionar saldo</th><th /></tr></thead>
            <tbody>
              {d.clients.map((c) => {
                const v = E(c);
                return (
                  <tr key={c.id}>
                    <td>{c.name}<br /><small>{c.ownerEmail} · {c.plan || 'sem plano'}{c.accessStatus === 'bloqueada' ? ' · BLOQUEADO' : ''}</small></td>
                    <td>{c.walletEnabled ? brl(c.balanceBrl) : 'não ativado'}</td>
                    <td><input style={{ width: 70 }} value={v.sms} onChange={(e) => setE(c, { sms: e.target.value })} aria-label="Preço do SMS" /></td>
                    <td><input style={{ width: 70 }} value={v.vo} onChange={(e) => setE(c, { vo: e.target.value })} aria-label="Voz saída por minuto" /></td>
                    <td><input style={{ width: 70 }} value={v.vi} onChange={(e) => setE(c, { vi: e.target.value })} aria-label="Voz entrada por minuto" /></td>
                    <td><input style={{ width: 80 }} value={v.add} onChange={(e) => setE(c, { add: e.target.value })} placeholder="R$" aria-label="Valor a adicionar" /> <button className="btn-outline" onClick={() => addCredit(c)} disabled={!v.add}>Adicionar</button></td>
                    <td><button className="btn-outline" onClick={() => saveRates(c)}>Salvar tarifas</button> <button className="btn-outline" onClick={() => block(c, c.accessStatus !== 'bloqueada')}>{c.accessStatus === 'bloqueada' ? 'Liberar' : 'Bloquear'}</button></td>
                  </tr>
                );
              })}
              {d.clients.length === 0 && <tr><td colSpan={7} className="acc-muted">Nenhum cliente ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
