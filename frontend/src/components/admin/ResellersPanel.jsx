// frontend/src/components/admin/ResellersPanel.jsx — administrador: marca contas como revendedoras
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import '../account/Account.css';

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function ResellersPanel() {
  const [items, setItems] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [pick, setPick] = useState('');
  const [max, setMax] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try { setItems((await api.get('/admin/resellers')).data.items); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao carregar.' }); }
  }, []);
  useEffect(() => { load(); api.get('/admin/accounts').then((r) => setAccounts(r.data.accounts || [])).catch(() => {}); }, [load]);

  async function set(id, isReseller, maxClients) {
    try { await api.put(`/admin/resellers/${id}`, { isReseller, maxClients }); setMsg({ text: 'Salvo.' }); setPick(''); setMax(''); load(); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao salvar.' }); }
  }

  return (
    <div>
      <div className="acc-card">
        <h3>🏪 Revendedores (agências)</h3>
        <p className="acc-muted">Uma conta revendedora cria os próprios clientes e define o preço de venda a eles. <strong>Tarifa de atacado = as tarifas da conta do revendedor</strong> (SMS e voz), que você define em <em>Gateway de telecom → tarifas da conta</em>. Conforme os clientes usam, o atacado é debitado da <strong>carteira do revendedor</strong>; sem saldo, os clientes dele pausam. O revendedor nunca consegue vender abaixo do atacado.</p>
        {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
        <div className="acc-grid">
          <div><label htmlFor="rs-acc">Tornar revendedora a conta</label>
            <select id="rs-acc" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Escolha…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div><label htmlFor="rs-max">Limite de clientes (vazio = sem limite)</label><input id="rs-max" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
        <div className="acc-row"><button className="btn-primary" disabled={!pick} onClick={() => set(pick, true, max)}>Marcar como revendedora</button></div>
      </div>
      <div className="acc-card">
        <h3>Revendedores ativos ({items.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Revendedor</th><th>Clientes</th><th>Atacado SMS</th><th>Atacado voz (saída/entrada)</th><th>Saldo</th><th /></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td><td>{r.clients}{r.resellerMaxClients != null ? ` / ${r.resellerMaxClients}` : ''}</td>
                  <td>{brl(r.wholesale.smsPerPartBrl)}</td><td>{brl(r.wholesale.voiceOutPerMinBrl)} / {brl(r.wholesale.voiceInPerMinBrl)}</td><td>{brl(r.wholesale.balanceBrl)}</td>
                  <td><button className="btn-outline" onClick={() => { if (window.confirm('Remover o status de revendedor? Os clientes dele continuam existindo.')) set(r.id, false, r.resellerMaxClients); }}>Remover</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="acc-muted">Nenhum revendedor ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
