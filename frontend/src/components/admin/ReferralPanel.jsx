// frontend/src/components/admin/ReferralPanel.jsx — regras do programa de indicação
import { useState, useEffect } from 'react';
import api from '../../services/api';
import '../account/Account.css';

export default function ReferralPanel() {
  const [s, setS] = useState({ enabled: true, percent: 10, maxBonusBrl: 200 });
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.get('/admin/referral').then((r) => setS(r.data)).catch(() => {}); }, []);
  async function save(e) {
    e.preventDefault();
    try { await api.put('/admin/referral', s); setMsg({ text: 'Regras salvas.' }); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao salvar.' }); }
  }
  return (
    <form className="acc-card" onSubmit={save}>
      <h3>🤝 Programa de indicação</h3>
      <p className="acc-muted">Quando uma conta indicada paga a primeira mensalidade, quem indicou recebe esse percentual em saldo da carteira (uma única vez por indicado).</p>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
      <div className="acc-grid">
        <div><label htmlFor="rf-on">Programa</label><select id="rf-on" value={s.enabled ? '1' : '0'} onChange={(e) => setS({ ...s, enabled: e.target.value === '1' })}><option value="1">Ativo</option><option value="0">Desativado</option></select></div>
        <div><label htmlFor="rf-pct">Bônus (% da 1ª mensalidade)</label><input id="rf-pct" type="number" min="0" max="100" step="1" value={s.percent} onChange={(e) => setS({ ...s, percent: e.target.value })} /></div>
        <div><label htmlFor="rf-max">Teto por indicado (R$)</label><input id="rf-max" type="number" min="0" step="1" value={s.maxBonusBrl} onChange={(e) => setS({ ...s, maxBonusBrl: e.target.value })} /></div>
      </div>
      <div className="acc-row"><button className="btn-primary" type="submit">Salvar</button></div>
    </form>
  );
}
