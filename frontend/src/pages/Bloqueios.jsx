// frontend/src/pages/Bloqueios.jsx — lista de bloqueio (opt-out): números que não devem receber SMS, ligações ou disparos
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import useCurrentUser from '../hooks/useCurrentUser';
import '../components/account/Account.css';

const CHANNELS = { all: 'Todos os canais', sms: 'Só SMS', voice: 'Só ligações', whatsapp: 'Só WhatsApp' };
const SOURCES = { manual: 'Cadastrado por você', sms_reply: 'Respondeu SAIR por SMS', robo: 'Pediu no robô de voz', ia: 'Pediu na ligação da IA', lead: 'Contato marcado', import: 'Importado', api: 'API' };

export default function Bloqueios() {
  const user = useCurrentUser();
  const canRemove = user.role === 'owner' || user.role === 'admin';
  const [data, setData] = useState({ items: [], total: 0 });
  const [q, setQ] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState('all');
  const [bulk, setBulk] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try { setData((await api.get('/account/opt-outs', { params: { q } })).data); } catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao carregar.' }); }
  }, [q]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    try { await api.post('/account/opt-outs', { phone, channel }); setPhone(''); setMsg({ text: 'Número bloqueado.' }); load(); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao bloquear.' }); }
  }
  async function importBulk() {
    try {
      const { data: r } = await api.post('/account/opt-outs', { numbers: bulk, channel });
      setMsg({ text: `${r.added} número(s) bloqueado(s).${r.invalidCount ? ` ${r.invalidCount} inválido(s): ${r.invalid.join(', ')}` : ''}` });
      setBulk(''); load();
    } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao importar.' }); }
  }
  async function remove(id) {
    try { await api.delete(`/account/opt-outs/${id}`); load(); } catch (err) { setMsg({ error: true, text: err.response?.data?.error || 'Erro ao remover.' }); }
  }

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <h1>🚫 Lista de bloqueio</h1>
      <p className="acc-muted">Números que pediram para não ser contatados. O sistema não envia SMS, não liga e não faz disparos para eles. Quando alguém responde SAIR, PARAR ou STOP a um SMS, ou pede para sair numa ligação do robô ou da IA, o número entra aqui sozinho. Isso protege seus números de bloqueio e a sua empresa de multas (LGPD).</p>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}

      <div className="acc-card">
        <h3>Bloquear um número</h3>
        <form onSubmit={add} className="acc-grid">
          <div><label htmlFor="bl-phone">Telefone</label><input id="bl-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 98888-7777" required /></div>
          <div><label htmlFor="bl-ch">Vale para</label><select id="bl-ch" value={channel} onChange={(e) => setChannel(e.target.value)}>{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div style={{ alignSelf: 'end' }}><button className="btn-primary" type="submit">Bloquear</button></div>
        </form>
        <details>
          <summary>Importar vários de uma vez</summary>
          <textarea rows={4} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="Um número por linha (ou separados por vírgula)" />
          <div className="acc-row"><button className="btn-outline" type="button" onClick={importBulk} disabled={!bulk.trim()}>Importar lista</button></div>
        </details>
      </div>

      <div className="acc-card">
        <div className="acc-row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Números bloqueados ({data.total})</h3>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar número" aria-label="Buscar número" />
        </div>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Número</th><th>Vale para</th><th>Origem</th><th>Data</th><th /></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>+{i.phone}</td><td>{CHANNELS[i.channel] || i.channel}</td>
                  <td>{SOURCES[i.source] || i.source}{i.reason ? <div className="acc-muted">{i.reason}</div> : null}</td>
                  <td>{new Date(i.createdAt).toLocaleDateString('pt-BR')}</td>
                  <td>{canRemove && <button className="btn-outline" onClick={() => remove(i.id)}>Remover</button>}</td>
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={5} className="acc-muted">Nenhum número bloqueado.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
