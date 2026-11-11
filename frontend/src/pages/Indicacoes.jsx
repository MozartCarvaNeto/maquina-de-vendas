// frontend/src/pages/Indicacoes.jsx — "Indique e ganhe": link de indicação e bônus recebidos
import { useState, useEffect } from 'react';
import api from '../services/api';
import '../components/account/Account.css';

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function Indicacoes() {
  const [d, setD] = useState(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.get('/account/referral').then((r) => setD(r.data)).catch((e) => setErr(e.response?.data?.error || 'Erro ao carregar.')); }, []);

  async function copy() {
    try { await navigator.clipboard.writeText(d.link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copie o link:', d.link); }
  }
  if (err) return <div style={{ padding: 24 }} className="acc-msg is-error">{err}</div>;
  if (!d) return <div style={{ padding: 24 }}>Carregando…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <h1>🤝 Indique e ganhe</h1>
      {!d.enabled ? <p className="acc-muted">O programa de indicação está desativado no momento.</p> : (
        <p className="acc-muted">Compartilhe seu link. Quando alguém se cadastrar por ele e pagar a primeira mensalidade, você ganha <strong>{d.percent}%</strong> do valor pago como <strong>saldo na carteira</strong> (até {brl(d.maxBonusBrl)} por indicado).</p>
      )}
      <div className="acc-card">
        <label htmlFor="ref-link">Seu link de indicação</label>
        <div className="acc-row">
          <input id="ref-link" readOnly value={d.link} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
          <button className="btn-primary" onClick={copy}>{copied ? 'Copiado!' : 'Copiar'}</button>
        </div>
        <p className="acc-muted">Seu código: <strong>{d.code}</strong> · Total ganho: <strong>{brl(d.totalEarnedBrl)}</strong></p>
      </div>
      <div className="acc-card">
        <h3>Pessoas indicadas ({d.referred.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Empresa</th><th>Cadastro</th><th>Situação</th><th>Bônus</th></tr></thead>
            <tbody>
              {d.referred.map((r, i) => (
                <tr key={i}><td>{r.name}</td><td>{new Date(r.createdAt).toLocaleDateString('pt-BR')}</td><td>{r.paid ? 'Pagou — bônus liberado' : 'Cadastrada, aguardando 1º pagamento'}</td><td>{r.paid ? brl(r.bonusBrl) : '—'}</td></tr>
              ))}
              {d.referred.length === 0 && <tr><td colSpan={4} className="acc-muted">Ninguém indicado ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
