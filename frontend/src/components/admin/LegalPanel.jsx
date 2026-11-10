// frontend/src/components/admin/LegalPanel.jsx — texto dos Termos de Uso e da Política de Privacidade
import { useState, useEffect } from 'react';
import api from '../../services/api';
import '../account/Account.css';

// Formato simples: cada linha "# Título" abre uma seção; os parágrafos vêm depois, separados por linha em branco.
const toText = (secs) => (secs || []).map((s) => `# ${s.h}\n${s.p.join('\n\n')}`).join('\n\n');
function toSections(text) {
  const out = []; let cur = null;
  for (const block of String(text || '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines[0].startsWith('# ')) { cur = { h: lines[0].slice(2).trim(), p: [] }; out.push(cur); const rest = lines.slice(1).join('\n').trim(); if (rest) cur.p.push(rest); }
    else if (block.trim()) { if (!cur) { cur = { h: '', p: [] }; out.push(cur); } cur.p.push(block.trim()); }
  }
  return out;
}

export default function LegalPanel() {
  const [d, setD] = useState(null);
  const [terms, setTerms] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.get('/admin/legal').then((r) => { setD(r.data); setTerms(toText(r.data.terms)); setPrivacy(toText(r.data.privacy)); }).catch(() => setMsg({ error: true, text: 'Erro ao carregar.' })); }, []);
  async function save() {
    try { const { data } = await api.put('/admin/legal', { terms: toSections(terms), privacy: toSections(privacy) }); setD(data); setMsg({ text: `Salvo. Nova versão ${data.version}: todos os clientes serão pedidos a aceitar de novo.` }); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao salvar.' }); }
  }
  if (!d) return <p>Carregando…</p>;
  return (
    <section className="acc-card">
      <h3>Termos de Uso e Política de Privacidade</h3>
      <p className="acc-muted">Os textos abaixo são um modelo, escrito para servir de ponto de partida. Leve a um advogado antes de vender. Ao salvar, a versão muda e cada cliente precisa aceitar de novo no próximo acesso. Dados da empresa (nome, CNPJ, e-mail) vêm das variáveis LEGAL_COMPANY_NAME, LEGAL_COMPANY_TAX_ID e LEGAL_CONTACT_EMAIL do servidor. Versão atual: {d.version}{d.custom ? ' (texto próprio)' : ' (modelo)'}.</p>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
      <label htmlFor="lg-terms"><strong>Termos de Uso</strong></label>
      <textarea id="lg-terms" rows={14} value={terms} onChange={(e) => setTerms(e.target.value)} />
      <label htmlFor="lg-priv"><strong>Política de Privacidade</strong></label>
      <textarea id="lg-priv" rows={14} value={privacy} onChange={(e) => setPrivacy(e.target.value)} />
      <p className="acc-muted">Cada seção começa com uma linha “# Título”. Separe os parágrafos com uma linha em branco.</p>
      <div className="acc-row"><button className="btn-primary" onClick={save}>Salvar nova versão</button><a href="/termos" target="_blank" rel="noopener noreferrer">Ver página pública</a></div>
    </section>
  );
}
