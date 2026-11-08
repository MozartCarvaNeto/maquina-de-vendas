// frontend/src/components/gateway/GatewayExtras.jsx
// Abas extras do Gateway de telecom: caixa de entrada de SMS (conversas) e saldo pré-pago.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const errText = (e) => e.response?.data?.error || e.message || 'Erro';
const STATUS = { queued: 'Na fila', sending: 'Enviando', sent: 'Enviado', delivered: 'Entregue', undelivered: 'Não entregue', failed: 'Falhou', received: 'Recebido' };

export function ConversasTab({ flash: flashProp }) {
  const ref = useRef(flashProp);
  ref.current = flashProp;
  const flash = useCallback((t) => ref.current(t), []);
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null); // número aberto
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [sendAt, setSendAt] = useState('');
  const bottom = useRef(null);

  const loadList = useCallback(async () => {
    try { setList((await api.get('/gateway/conversations')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [flash]);
  const loadThread = useCallback(async () => {
    if (!open) return;
    try { setMsgs((await api.get(`/gateway/conversations/${encodeURIComponent(open)}`)).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [open, flash]);
  useEffect(() => { loadList(); const t = setInterval(loadList, 6000); return () => clearInterval(t); }, [loadList]);
  useEffect(() => { loadThread(); if (!open) return undefined; const t = setInterval(loadThread, 4000); return () => clearInterval(t); }, [open, loadThread]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  const send = async (e) => {
    e.preventDefault();
    try {
      await api.post('/gateway/send', { to: open, body: text, sendAt: sendAt ? new Date(sendAt).toISOString() : undefined });
      setText(''); setSendAt('');
      flash(sendAt ? '✅ SMS agendado.' : '✅ SMS enviado para a fila.');
      setTimeout(() => { loadThread(); loadList(); }, 800);
    } catch (err) { flash(`❌ ${errText(err)}`); }
  };
  const cancel = async (id) => {
    try { await api.delete(`/gateway/messages/${id}`); flash('✅ Agendamento cancelado (valor estornado).'); loadThread(); } catch (err) { flash(`❌ ${errText(err)}`); }
  };

  return (
    <div className="card">
      <p className="card-desc">Conversas por SMS: as respostas dos clientes chegam aqui e você responde (ou agenda) direto daqui.</p>
      <div className="gw-row">
        <input placeholder="Novo número (11 99999-8888)" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} />
        <button type="button" className="btn-secondary-small" onClick={() => { if (newNumber.replace(/\D/g, '').length >= 10) { setOpen(newNumber); setNewNumber(''); } }}>Abrir conversa</button>
      </div>
      <div className="gw-chat">
        <div className="gw-chat-list">
          {list.map((c) => (
            <button key={c.key} type="button" className={open && open.replace(/\D/g, '').endsWith(c.key) ? 'active' : ''} onClick={() => setOpen(c.number)}>
              <strong>{c.number}</strong>{c.lastDirection === 'in' && ' 💬'}
              <small>{c.lastBody}</small>
            </button>
          ))}
          {!list.length && <p className="hint-text">Nenhuma conversa ainda.</p>}
        </div>
        <div className="gw-chat-thread">
          {!open && <p className="hint-text">Escolha uma conversa ao lado.</p>}
          {open && (
            <>
              <h4>{open}</h4>
              <div className="gw-chat-msgs">
                {msgs.map((m) => (
                  <div key={m.id} className={`gw-bubble ${m.direction === 'in' ? 'in' : 'out'}`}>
                    <div>{m.body}</div>
                    <small>
                      {new Date(m.createdAt).toLocaleString('pt-BR')} · {m.scheduledFor ? `agendado para ${new Date(m.scheduledFor).toLocaleString('pt-BR')}` : STATUS[m.status] || m.status}
                      {m.scheduledFor && <> · <button type="button" className="btn-link" onClick={() => cancel(m.id)}>cancelar</button></>}
                      {m.error && m.status === 'failed' ? ` · ${m.error}` : ''}
                    </small>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <form onSubmit={send} className="gw-form">
                <textarea rows={2} maxLength={1600} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva a resposta…" required />
                <div className="gw-row">
                  <div><label>Agendar para (opcional)</label><input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} /></div>
                  <div style={{ alignSelf: 'flex-end' }}><button className="btn-primary" type="submit">{sendAt ? 'Agendar' : 'Enviar'}</button></div>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SaldoTab({ flash: flashProp }) {
  const ref = useRef(flashProp);
  ref.current = flashProp;
  const flash = useCallback((t) => ref.current(t), []);
  const user = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const [me, setMe] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [sel, setSel] = useState('');
  const [credit, setCredit] = useState('');
  const [rates, setRates] = useState({});

  const loadMe = useCallback(async () => { try { setMe((await api.get('/gateway/wallet')).data); } catch (e) { flash(`❌ ${errText(e)}`); } }, [flash]);
  const loadAccounts = useCallback(async () => {
    if (!user.isPlatformAdmin) return;
    try { setAccounts((await api.get('/gateway/wallet/accounts')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [flash, user.isPlatformAdmin]);
  useEffect(() => { loadMe(); loadAccounts(); }, [loadMe, loadAccounts]);

  const acc = accounts.find((a) => a.id === sel);
  useEffect(() => {
    if (acc) setRates({ enabled: acc.enabled, smsPerPartBrl: acc.smsPerPartBrl, voiceOutPerMinBrl: acc.voiceOutPerMinBrl, voiceInPerMinBrl: acc.voiceInPerMinBrl, voiceIncrementSec: acc.voiceIncrementSec });
  }, [acc]);

  const doCredit = async () => {
    try { await api.post(`/gateway/wallet/${sel}/credit`, { amountBrl: Number(String(credit).replace(',', '.')) }); setCredit(''); flash('✅ Recarga feita.'); loadAccounts(); loadMe(); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const saveRates = async () => {
    try { await api.put(`/gateway/wallet/${sel}/rates`, rates); flash('✅ Tarifas salvas.'); loadAccounts(); loadMe(); } catch (e) { flash(`❌ ${errText(e)}`); }
  };

  return (
    <div className="card">
      {me && (
        <>
          <h3>Seu saldo</h3>
          {me.enabled ? (
            <>
              <p className="gw-balance">{brl(me.balanceBrl)}</p>
              <p className="hint-text">SMS: {brl(me.rates.smsPerPartBrl)} por parte · Ligação feita: {brl(me.rates.voiceOutPerMinBrl)}/min · Ligação recebida: {brl(me.rates.voiceInPerMinBrl)}/min (cobrança a cada {me.rates.voiceIncrementSec}s). Ao zerar, os envios e as ligações são bloqueados até uma nova recarga.</p>
            </>
          ) : <p className="hint-text">Sua conta usa o serviço sem limite de saldo (pré-pago desligado).</p>}
          <table className="gw-table">
            <thead><tr><th>Quando</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th>Saldo</th></tr></thead>
            <tbody>
              {me.txs.map((t) => (
                <tr key={t.id}><td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td><td>{t.type}</td><td>{t.description}</td>
                  <td style={{ color: t.amountBrl < 0 ? '#b91c1c' : '#15803d' }}>{brl(t.amountBrl)}</td><td>{brl(t.balanceAfter)}</td></tr>
              ))}
              {!me.txs.length && <tr><td colSpan={5}>Sem movimentações.</td></tr>}
            </tbody>
          </table>
        </>
      )}
      {user.isPlatformAdmin && (
        <div className="gw-form">
          <h3>Administração dos saldos (só você, administrador da plataforma)</h3>
          <select value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">— escolha a conta —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.enabled ? brl(a.balanceBrl) : 'sem limite'}</option>)}
          </select>
          {acc && (
            <>
              <p>Saldo atual: <strong>{brl(acc.balanceBrl)}</strong> {acc.enabled ? '(pré-pago ligado)' : '(pré-pago desligado)'}</p>
              <div className="gw-row">
                <input placeholder="Valor da recarga (R$)" value={credit} onChange={(e) => setCredit(e.target.value)} />
                <button type="button" className="btn-primary" onClick={doCredit}>Recarregar</button>
              </div>
              <label><input type="checkbox" checked={!!rates.enabled} onChange={(e) => setRates({ ...rates, enabled: e.target.checked })} /> Ligar pré-pago nesta conta (bloqueia sem saldo)</label>
              <div className="gw-row">
                <div><label>SMS por parte (R$)</label><input value={rates.smsPerPartBrl ?? ''} onChange={(e) => setRates({ ...rates, smsPerPartBrl: e.target.value })} /></div>
                <div><label>Ligação feita por minuto (R$)</label><input value={rates.voiceOutPerMinBrl ?? ''} onChange={(e) => setRates({ ...rates, voiceOutPerMinBrl: e.target.value })} /></div>
                <div><label>Ligação recebida por minuto (R$)</label><input value={rates.voiceInPerMinBrl ?? ''} onChange={(e) => setRates({ ...rates, voiceInPerMinBrl: e.target.value })} /></div>
                <div><label>Cobrar a cada</label>
                  <select value={rates.voiceIncrementSec ?? 60} onChange={(e) => setRates({ ...rates, voiceIncrementSec: Number(e.target.value) })}><option value={1}>1 segundo</option><option value={6}>6 segundos</option><option value={30}>30 segundos</option><option value={60}>1 minuto</option></select></div>
              </div>
              <button type="button" className="btn-primary" onClick={saveRates}>Salvar tarifas</button>
              <p className="hint-text">O que a conta paga é a tarifa acima; o que você paga ao fornecedor continua no "Consumo". Se o pré-pago estiver ligado, só você muda o preço do SMS.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
