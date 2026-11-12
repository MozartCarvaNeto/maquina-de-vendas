// frontend/src/components/admin/OfficialWhatsappPanel.jsx
// Administrador: coloca um número do WhatsApp oficial (Cloud API, da SUA conta Meta) para um cliente.
// As mensagens são cobradas do saldo do cliente pela tarifa definida em Gateway > Regras (ou preço próprio da conexão).
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import '../account/Account.css';

const empty = { accountId: '', instanceName: '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '', priceBrl: '' };

export default function OfficialWhatsappPanel() {
  const [data, setData] = useState({ items: [], webhookUrl: '' });
  const [accounts, setAccounts] = useState([]);
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try { setData((await api.get('/admin/whatsapp-official')).data); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao carregar.' }); }
  }, []);
  useEffect(() => {
    load();
    api.get('/admin/accounts').then((r) => setAccounts(r.data.accounts || r.data || [])).catch(() => {});
  }, [load]);

  async function create(e) {
    e.preventDefault();
    try {
      const { data: r } = await api.post('/admin/whatsapp-official', f);
      setMsg({ text: `Número cadastrado. Na Meta, use o token de verificação: ${r.webhookVerifyToken}` });
      setF(empty);
      load();
    } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao cadastrar.' }); }
  }
  async function setPrice(id, priceBrl) {
    try { await api.put(`/admin/whatsapp-official/${id}`, { priceBrl }); load(); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro.' }); }
  }
  async function remove(id) {
    if (!window.confirm('Remover este número do cliente?')) return;
    try { await api.delete(`/admin/whatsapp-official/${id}`); load(); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro.' }); }
  }

  return (
    <div>
      <div className="acc-card">
        <h3>💬 WhatsApp oficial (Cloud API) gerenciado por você</h3>
        <p className="acc-muted">Cadastre aqui o número da <strong>sua</strong> conta Meta para um cliente. O cliente usa esse número no sistema sem mexer em token, e cada mensagem enviada é cobrada do saldo dele (tarifa em <em>Gateway de telecom → Custos e recarga</em>, ou um preço próprio por número abaixo). Se o envio falhar, o valor é devolvido.</p>
        <p className="acc-muted">No painel da Meta, em Webhook, use a URL <code>{data.webhookUrl}</code> e o token de verificação mostrado abaixo de cada número. Assine o campo <code>messages</code>.</p>
        {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
        <form onSubmit={create}>
          <div className="acc-grid">
            <div><label htmlFor="ow-acc">Cliente</label>
              <select id="ow-acc" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                <option value="">Escolha…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select></div>
            <div><label htmlFor="ow-name">Nome da conexão</label><input id="ow-name" value={f.instanceName} onChange={(e) => setF({ ...f, instanceName: e.target.value })} placeholder="WhatsApp oficial" /></div>
            <div><label htmlFor="ow-pid">Phone Number ID</label><input id="ow-pid" required value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} /></div>
            <div><label htmlFor="ow-waba">WABA ID (opcional)</label><input id="ow-waba" value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} /></div>
            <div><label htmlFor="ow-tok">Token de acesso permanente</label><input id="ow-tok" type="password" required value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} autoComplete="off" /></div>
            <div><label htmlFor="ow-sec">App Secret (recomendado)</label><input id="ow-sec" type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} autoComplete="off" /></div>
            <div><label htmlFor="ow-price">Preço por mensagem (R$) — vazio = padrão</label><input id="ow-price" value={f.priceBrl} onChange={(e) => setF({ ...f, priceBrl: e.target.value })} /></div>
          </div>
          <div className="acc-row"><button className="btn-primary" type="submit">Cadastrar número</button></div>
        </form>
      </div>
      <div className="acc-card">
        <h3>Números cadastrados ({data.items.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Cliente</th><th>Número</th><th>Preço/msg</th><th>Token de verificação (Meta)</th><th /></tr></thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.accountName}</td><td>{c.phone || c.phoneNumberId}</td>
                  <td><input style={{ width: 80 }} defaultValue={c.priceBrl ?? ''} placeholder="padrão" onBlur={(e) => setPrice(c.id, e.target.value)} /></td>
                  <td><code>{c.webhookVerifyToken}</code></td>
                  <td><button className="btn-outline" onClick={() => remove(c.id)}>Remover</button></td>
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={5} className="acc-muted">Nenhum número cadastrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
