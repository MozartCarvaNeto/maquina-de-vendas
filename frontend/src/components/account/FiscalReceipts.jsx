// frontend/src/components/account/FiscalReceipts.jsx — dados para recibo/nota e lista de recibos
import { useState, useEffect } from 'react';
import api from '../../services/api';
import './Account.css';

const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTax = (d) => { const x = String(d || '').replace(/\D/g, ''); return x.length === 11 ? x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : x.length === 14 ? x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d || ''; };

export default function FiscalReceipts() {
  const [f, setF] = useState({ legalName: '', taxId: '', fiscalEmail: '', fiscalAddress: '' });
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    api.get('/account/fiscal').then((r) => setF({ ...r.data, taxId: fmtTax(r.data.taxId) })).catch(() => {});
    api.get('/account/receipts').then((r) => setList(r.data.receipts)).catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function save(e) {
    e.preventDefault();
    try { const { data } = await api.put('/account/fiscal', f); setF({ ...data, taxId: fmtTax(data.taxId) }); setMsg({ text: 'Dados salvos.' }); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao salvar.' }); }
  }

  async function open(r) {
    try {
      const { data } = await api.get(`/account/receipts/${r.kind}/${r.id}`);
      const { receipt: x, seller, customer, notice } = data;
      const w = window.open('', '_blank');
      if (!w) { setMsg({ error: true, text: 'O navegador bloqueou a janela. Libere pop-ups para ver o recibo.' }); return; }
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(x.number)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:6px 0;border-bottom:1px solid #ddd}small{color:#555}.v{font-size:26px;font-weight:700}button{margin-top:16px;padding:8px 14px}@media print{button{display:none}}</style></head><body>
<h1>Recibo ${esc(x.number)}</h1><p><small>${esc(seller.name)}${seller.taxId ? ' · CNPJ/CPF ' + esc(seller.taxId) : ''}<br>${esc(seller.email)}</small></p>
<table><tr><td>Recebemos de</td><td><b>${esc(customer.name)}</b><br><small>${esc(fmtTax(customer.taxId))}${customer.address ? '<br>' + esc(customer.address) : ''}</small></td></tr>
<tr><td>Referente a</td><td>${esc(x.description)}</td></tr><tr><td>Data do pagamento</td><td>${new Date(x.paidAt).toLocaleDateString('pt-BR')}</td></tr>
<tr><td>Valor</td><td class="v">${esc(money(x.amount))}</td></tr>${x.nfseNumber ? `<tr><td>Nota fiscal</td><td>Nº ${esc(x.nfseNumber)}${x.nfseUrl ? ` · <a href="${esc(x.nfseUrl)}">abrir</a>` : ''}</td></tr>` : ''}</table>
<p><small>${esc(notice)}</small></p><button onclick="window.print()">Imprimir / salvar em PDF</button></body></html>`);
      w.document.close();
    } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao abrir o recibo.' }); }
  }

  return (
    <>
      <section className="acc-card">
        <h2>Dados para recibo e nota fiscal</h2>
        <p className="acc-muted">Usados nos seus recibos e na emissão da nota fiscal de serviço.</p>
        {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
        <form onSubmit={save}>
          <div className="acc-grid">
            <div><label htmlFor="fz-name">Razão social ou nome completo</label><input id="fz-name" value={f.legalName} onChange={set('legalName')} /></div>
            <div><label htmlFor="fz-tax">CPF ou CNPJ</label><input id="fz-tax" value={f.taxId} onChange={set('taxId')} inputMode="numeric" /></div>
            <div><label htmlFor="fz-mail">E-mail para receber a nota</label><input id="fz-mail" type="email" value={f.fiscalEmail} onChange={set('fiscalEmail')} /></div>
          </div>
          <div className="acc-grid"><div><label htmlFor="fz-addr">Endereço completo</label><textarea id="fz-addr" rows={2} value={f.fiscalAddress} onChange={set('fiscalAddress')} placeholder="Rua, número, bairro, cidade/UF, CEP" /></div></div>
          <button className="btn-primary" type="submit">Salvar dados</button>
        </form>
      </section>
      <section className="acc-card">
        <h2>Recibos e notas</h2>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Data</th><th>Descrição</th><th>Valor</th><th>Nota fiscal</th><th /></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.kind + r.id}>
                  <td>{new Date(r.paidAt).toLocaleDateString('pt-BR')}</td><td>{r.description}</td><td>{money(r.amount)}</td>
                  <td>{r.nfseNumber ? (r.nfseUrl ? <a href={r.nfseUrl} target="_blank" rel="noopener noreferrer">Nº {r.nfseNumber}</a> : `Nº ${r.nfseNumber}`) : <span className="acc-muted">a emitir</span>}</td>
                  <td><button className="btn-outline" onClick={() => open(r)}>Ver recibo</button></td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={5} className="acc-muted">Nenhum pagamento confirmado ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
