// frontend/src/pages/GatewayTelecom.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './GatewayTelecom.css';

const TABS = [
  ['fornecedores', '📡 Fornecedores de SMS'],
  ['mensagens', '✉️ Enviar e acompanhar'],
  ['consumo', '💰 Consumo'],
  ['api', '🔑 API'],
  ['voz', '☎️ Voz (SIP)']
];

const emptyCarrier = {
  name: '', host: '', port: 2775, useTls: false, systemId: '', password: '', systemType: '', defaultSender: '',
  tps: 10, windowSize: 10, priority: 1, costPerPart: 0, normalize: 'keep', concatMode: 'udh', allowedPrefixes: '', enabled: true
};
const emptyTrunk = { name: '', host: '', port: 5060, transport: 'udp', username: '', password: '', register: true, fromDomain: '', outboundCallerId: '', dialPrefix: '', codecs: 'alaw,ulaw', enabled: true };

const STATUS_LABEL = { queued: 'Na fila', sending: 'Enviando', sent: 'Enviado ao fornecedor', delivered: 'Entregue', undelivered: 'Não entregue', failed: 'Falhou', received: 'Recebido' };
const STATE_LABEL = { bound: '🟢 Conectado', connecting: '🟡 Conectando…', closed: '🔴 Desconectado', parado: '⚪ Parado', erro: '🔴 Erro' };

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function GatewayTelecom() {
  const [tab, setTab] = useState('fornecedores');
  const [overview, setOverview] = useState(null);
  const [msg, setMsg] = useState('');
  const [carrier, setCarrier] = useState(null); // formulário aberto (novo ou edição)
  const [messages, setMessages] = useState([]);
  const [direction, setDirection] = useState('');
  const [sendForm, setSendForm] = useState({ to: '', body: '', from: '' });
  const [preview, setPreview] = useState(null);
  const [usage, setUsage] = useState(null);
  const [days, setDays] = useState(30);
  const [keys, setKeys] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [keyName, setKeyName] = useState('');
  const [trunks, setTrunks] = useState([]);
  const [trunk, setTrunk] = useState(null);
  const [asterisk, setAsterisk] = useState(null);
  const [price, setPrice] = useState('');

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 6000); };
  const errText = (e) => e.response?.data?.error || e.message || 'Erro';

  const loadOverview = useCallback(async () => {
    try {
      const { data } = await api.get('/gateway/overview');
      setOverview(data);
      setPrice(String(data.settings?.priceBrl ?? ''));
    } catch (e) { flash(`❌ ${errText(e)}`); }
  }, []);
  const loadMessages = useCallback(async () => {
    try { setMessages((await api.get('/gateway/messages', { params: { direction: direction || undefined, limit: 60 } })).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [direction]);
  const loadUsage = useCallback(async () => {
    try { setUsage((await api.get('/gateway/usage', { params: { days } })).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [days]);
  const loadKeys = useCallback(async () => { try { setKeys((await api.get('/gateway/keys')).data); } catch (e) { flash(`❌ ${errText(e)}`); } }, []);
  const loadTrunks = useCallback(async () => { try { setTrunks((await api.get('/gateway/trunks')).data); } catch (e) { flash(`❌ ${errText(e)}`); } }, []);

  useEffect(() => { loadOverview(); const t = setInterval(loadOverview, 8000); return () => clearInterval(t); }, [loadOverview]);
  useEffect(() => { if (tab === 'mensagens') { loadMessages(); const t = setInterval(loadMessages, 5000); return () => clearInterval(t); } return undefined; }, [tab, loadMessages]);
  useEffect(() => { if (tab === 'consumo') loadUsage(); }, [tab, loadUsage]);
  useEffect(() => { if (tab === 'api') loadKeys(); }, [tab, loadKeys]);
  useEffect(() => { if (tab === 'voz') loadTrunks(); }, [tab, loadTrunks]);
  useEffect(() => {
    if (!sendForm.body) { setPreview(null); return undefined; }
    const t = setTimeout(async () => {
      try { setPreview((await api.post('/gateway/segments', { body: sendForm.body })).data); } catch (_) { /* ignora */ }
    }, 300);
    return () => clearTimeout(t);
  }, [sendForm.body]);

  async function saveCarrier(e) {
    e.preventDefault();
    try {
      if (carrier.id) await api.put(`/gateway/carriers/${carrier.id}`, carrier);
      else await api.post('/gateway/carriers', carrier);
      setCarrier(null);
      flash('✅ Fornecedor salvo. Conectando…');
      loadOverview();
    } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function removeCarrier(c) {
    if (!window.confirm(`Remover o fornecedor "${c.name}"?`)) return;
    try { await api.delete(`/gateway/carriers/${c.id}`); loadOverview(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function toggleCarrier(c) {
    try { await api.put(`/gateway/carriers/${c.id}`, { enabled: !c.enabled }); loadOverview(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function saveSettings(patch) {
    try { await api.put('/gateway/settings', patch); flash('✅ Salvo'); loadOverview(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function sendSms(e) {
    e.preventDefault();
    try {
      const { data } = await api.post('/gateway/send', sendForm);
      flash(`✅ SMS na fila (${data.parts} parte(s), ${data.encoding}). Acompanhe o status abaixo.`);
      setSendForm({ ...sendForm, body: '' });
      setTimeout(loadMessages, 1500);
    } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function createKey(e) {
    e.preventDefault();
    try { const { data } = await api.post('/gateway/keys', { name: keyName || 'Chave' }); setNewKey(data.key); setKeyName(''); loadKeys(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function removeKey(k) {
    if (!window.confirm(`Apagar a chave "${k.name}"? Sistemas que a usam vão parar de funcionar.`)) return;
    try { await api.delete(`/gateway/keys/${k.id}`); loadKeys(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function saveTrunk(e) {
    e.preventDefault();
    try {
      if (trunk.id) await api.put(`/gateway/trunks/${trunk.id}`, trunk);
      else await api.post('/gateway/trunks', trunk);
      setTrunk(null); setAsterisk(null); loadTrunks(); flash('✅ Tronco salvo');
    } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function removeTrunk(t) {
    if (!window.confirm(`Remover o tronco "${t.name}"?`)) return;
    try { await api.delete(`/gateway/trunks/${t.id}`); setAsterisk(null); loadTrunks(); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  async function genAsterisk() {
    try { setAsterisk((await api.get('/gateway/voice/asterisk-config')).data); } catch (err) { flash(`❌ ${errText(err)}`); }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
  }

  const apiBase = `${window.location.origin}/api/v1/sms/messages`;
  const set = (setter) => (field) => (e) => setter((cur) => ({ ...cur, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setC = set(setCarrier);
  const setT = set(setTrunk);

  return (
    <div className="gateway-page">
      <header>
        <h1>📡 Gateway de telecom</h1>
        <p>Seu próprio sistema de SMS (e base de voz): você liga fornecedores/operadoras por SMPP e SIP, e o portal faz fila, roteamento, relatório de entrega, API e consumo — sem depender de Twilio, Zenvia ou similares.</p>
      </header>

      {msg && <div className="gw-flash">{msg}</div>}

      <div className="gw-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'fornecedores' && (
        <div className="card">
          <p className="card-desc">
            Cadastre um ou mais fornecedores que lhe deram acesso <strong>SMPP</strong> (servidor, porta, usuário e senha). Os envios usam o de
            <strong> menor prioridade</strong> (1 = primeiro) e, se ele cair ou estourar o limite, o portal troca sozinho para o próximo.
          </p>
          {overview?.last24h && (
            <p className="hint-text">Últimas 24 h: {Object.entries(overview.last24h).map(([s, n]) => `${STATUS_LABEL[s] || s}: ${n}`).join(' · ') || 'nenhum envio'}</p>
          )}
          <table className="gw-table">
            <thead><tr><th>Fornecedor</th><th>Situação</th><th>Prioridade</th><th>Custo/parte</th><th>Ritmo</th><th /></tr></thead>
            <tbody>
              {(overview?.carriers || []).map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><br /><small>{c.host}:{c.port}{c.useTls ? ' (TLS)' : ''} · usuário {c.systemId}</small></td>
                  <td>{c.enabled ? (STATE_LABEL[c.runtime.state] || c.runtime.state) : '⏸️ Desligado'}{(c.runtime.error || c.lastError) && c.runtime.state !== 'bound' && <><br /><small className="gw-err">{c.runtime.error || c.lastError}</small></>}</td>
                  <td>{c.priority}</td>
                  <td>{brl(c.costPerPart)}</td>
                  <td>{c.tps}/s</td>
                  <td className="gw-actions">
                    <button type="button" className="btn-secondary-small" onClick={() => setCarrier({ ...c, password: '' })}>Editar</button>
                    <button type="button" className="btn-secondary-small" onClick={() => toggleCarrier(c)}>{c.enabled ? 'Desligar' : 'Ligar'}</button>
                    <button type="button" className="btn-secondary-small" onClick={() => removeCarrier(c)}>Remover</button>
                  </td>
                </tr>
              ))}
              {overview && overview.carriers.length === 0 && <tr><td colSpan={6}>Nenhum fornecedor cadastrado.</td></tr>}
            </tbody>
          </table>
          {!carrier && <button type="button" className="btn-primary" onClick={() => setCarrier({ ...emptyCarrier })}>+ Cadastrar fornecedor SMPP</button>}

          {carrier && (
            <form onSubmit={saveCarrier} className="gw-form">
              <h3>{carrier.id ? 'Editar fornecedor' : 'Novo fornecedor SMPP'}</h3>
              <label>Nome (só para você)</label>
              <input value={carrier.name} onChange={setC('name')} required />
              <div className="gw-row">
                <div><label>Servidor (host)</label><input value={carrier.host} onChange={setC('host')} placeholder="smpp.fornecedor.com.br" required /></div>
                <div><label>Porta</label><input type="number" value={carrier.port} onChange={setC('port')} /></div>
              </div>
              <label><input type="checkbox" checked={carrier.useTls} onChange={setC('useTls')} /> Conexão segura (TLS)</label>
              <div className="gw-row">
                <div><label>Usuário (system_id)</label><input value={carrier.systemId} onChange={setC('systemId')} required autoComplete="off" /></div>
                <div><label>Senha {carrier.hasPassword && '(deixe vazio para manter)'}</label><input type="password" value={carrier.password} onChange={setC('password')} autoComplete="new-password" /></div>
              </div>
              <div className="gw-row">
                <div><label>Remetente padrão (nome ou número liberado pelo fornecedor)</label><input value={carrier.defaultSender || ''} onChange={setC('defaultSender')} maxLength={20} /></div>
                <div><label>Prioridade (1 = primeiro)</label><input type="number" min="1" value={carrier.priority} onChange={setC('priority')} /></div>
              </div>
              <div className="gw-row">
                <div><label>Envios por segundo (limite do contrato)</label><input type="number" step="0.1" min="0.1" value={carrier.tps} onChange={setC('tps')} /></div>
                <div><label>Janela (envios simultâneos)</label><input type="number" min="1" value={carrier.windowSize} onChange={setC('windowSize')} /></div>
                <div><label>Custo por parte (R$)</label><input type="number" step="0.0001" min="0" value={carrier.costPerPart} onChange={setC('costPerPart')} /></div>
              </div>
              <div className="gw-row">
                <div><label>Acentos</label>
                  <select value={carrier.normalize} onChange={setC('normalize')}>
                    <option value="keep">Manter (acento pode reduzir para 70 letras por SMS)</option>
                    <option value="strip">Remover acentos (160 letras por SMS, mais barato)</option>
                  </select>
                </div>
                <div><label>SMS longo</label>
                  <select value={carrier.concatMode} onChange={setC('concatMode')}>
                    <option value="udh">Padrão (UDH)</option>
                    <option value="sar">Alternativo (SAR) — se o fornecedor pedir</option>
                  </select>
                </div>
              </div>
              <label>Só para destinos que começam com (opcional, separe por vírgula, ex.: 55)</label>
              <input value={carrier.allowedPrefixes || ''} onChange={setC('allowedPrefixes')} />
              <details><summary>Avançado</summary><label>system_type (só se o fornecedor exigir)</label><input value={carrier.systemType || ''} onChange={setC('systemType')} /></details>
              <div className="gw-actions"><button className="btn-primary" type="submit">Salvar e conectar</button> <button type="button" className="btn-secondary-small" onClick={() => setCarrier(null)}>Cancelar</button></div>
            </form>
          )}

          <h4 className="subsection-title">Opções do gateway</h4>
          <label><input type="checkbox" checked={Boolean(overview?.settings?.useInBroadcasts)} onChange={(e) => saveSettings({ useInBroadcasts: e.target.checked })} /> Usar este gateway nos Disparos de SMS (no lugar da Twilio)</label>
        </div>
      )}

      {tab === 'mensagens' && (
        <div className="card">
          <form onSubmit={sendSms} className="gw-form">
            <h3>Enviar um SMS agora</h3>
            <div className="gw-row">
              <div><label>Celular</label><input value={sendForm.to} onChange={(e) => setSendForm({ ...sendForm, to: e.target.value })} placeholder="11 99999-8888" required /></div>
              <div><label>Remetente (opcional)</label><input value={sendForm.from} onChange={(e) => setSendForm({ ...sendForm, from: e.target.value })} /></div>
            </div>
            <label>Mensagem</label>
            <textarea rows={3} maxLength={1600} value={sendForm.body} onChange={(e) => setSendForm({ ...sendForm, body: e.target.value })} required />
            {preview && <small>{sendForm.body.length} caracteres · {preview.parts} parte(s) · {preview.encoding === 'ucs2' ? 'com acentos/emoji (70 letras por parte)' : 'texto simples (160 letras por parte)'}</small>}
            <div><button className="btn-primary" type="submit">Enviar</button></div>
          </form>
          <h4 className="subsection-title">Mensagens</h4>
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">Enviadas e recebidas</option><option value="out">Só enviadas</option><option value="in">Só recebidas (respostas)</option>
          </select>
          <table className="gw-table">
            <thead><tr><th>Quando</th><th>De → Para</th><th>Texto</th><th>Status</th><th>Partes</th></tr></thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <td>{new Date(m.createdAt).toLocaleString('pt-BR')}</td>
                  <td>{m.direction === 'in' ? '⬅️' : '➡️'} {m.fromAddr} → {m.toAddr}</td>
                  <td className="gw-body">{m.body}</td>
                  <td>{STATUS_LABEL[m.status] || m.status}{m.errorMessage && m.status !== 'sent' && m.status !== 'delivered' && <><br /><small className="gw-err">{m.errorMessage}</small></>}</td>
                  <td>{m.parts}</td>
                </tr>
              ))}
              {messages.length === 0 && <tr><td colSpan={5}>Nada por aqui ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'consumo' && (
        <div className="card">
          <div className="gw-row">
            <div>
              <label>Preço que você cobra por parte de SMS (R$) — usado no extrato</label>
              <input type="number" step="0.0001" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button type="button" className="btn-secondary-small" onClick={() => saveSettings({ priceBrl: price })}>Salvar preço</button>
            </div>
            <div>
              <label>Período</label>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option>
              </select>
            </div>
          </div>
          {usage && (
            <>
              <p><strong>{usage.total.messages}</strong> SMS · <strong>{usage.total.parts}</strong> partes · entregues: <strong>{usage.total.delivered}</strong> · custo {brl(usage.total.cost)} · cobrado {brl(usage.total.revenue)} · margem <strong>{brl(usage.total.revenue - usage.total.cost)}</strong></p>
              <table className="gw-table">
                <thead><tr><th>Dia</th><th>SMS</th><th>Partes</th><th>Entregues</th><th>Custo</th><th>Cobrado</th></tr></thead>
                <tbody>{usage.byDay.map((d) => (<tr key={d.day}><td>{d.day.split('-').reverse().join('/')}</td><td>{d.messages}</td><td>{d.parts}</td><td>{d.delivered}</td><td>{brl(d.cost)}</td><td>{brl(d.revenue)}</td></tr>))}</tbody>
              </table>
            </>
          )}
        </div>
      )}

      {tab === 'api' && (
        <div className="card">
          <p className="card-desc">Outros sistemas (site, loja, ERP) podem enviar SMS pelo seu gateway usando uma chave de API.</p>
          <form onSubmit={createKey} className="gw-row">
            <input placeholder="Nome da chave (ex.: Loja virtual)" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            <button className="btn-primary" type="submit">Criar chave</button>
          </form>
          {newKey && (
            <div className="gw-newkey">Copie agora, ela não aparece de novo:<br /><code>{newKey}</code> <button type="button" className="btn-secondary-small" onClick={() => { navigator.clipboard?.writeText(newKey); }}>Copiar</button></div>
          )}
          <table className="gw-table">
            <thead><tr><th>Nome</th><th>Início da chave</th><th>Último uso</th><th /></tr></thead>
            <tbody>{keys.map((k) => (<tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('pt-BR') : '—'}</td><td><button type="button" className="btn-secondary-small" onClick={() => removeKey(k)}>Apagar</button></td></tr>))}</tbody>
          </table>
          <h4 className="subsection-title">Como usar</h4>
          <pre className="gw-pre">{`curl -X POST ${apiBase} \\
  -H "Authorization: Bearer SUA_CHAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"11999998888","body":"Seu pedido saiu para entrega!","clientRef":"pedido-123"}'

# Consultar o status (queued, sent, delivered, undelivered, failed):
curl ${apiBase}/ID_DA_MENSAGEM -H "Authorization: Bearer SUA_CHAVE"`}</pre>
        </div>
      )}

      {tab === 'voz' && (
        <div className="card">
          <p className="card-desc">
            Para ligações pelo seu próprio sistema, o servidor usa o <strong>Asterisk</strong> (PBX gratuito) ligado a um fornecedor de voz por <strong>tronco SIP</strong>.
            Cadastre o tronco aqui e gere os arquivos de configuração. Veja o passo a passo no guia da atualização.
            <br /><strong>Atenção:</strong> nesta versão o portal gera a configuração; ligar e atender pelo navegador será a próxima etapa.
          </p>
          <table className="gw-table">
            <thead><tr><th>Tronco</th><th>Servidor</th><th>Usuário</th><th /></tr></thead>
            <tbody>
              {trunks.map((t) => (
                <tr key={t.id}><td><strong>{t.name}</strong>{!t.enabled && ' (desligado)'}</td><td>{t.host}:{t.port} ({t.transport})</td><td>{t.username || '—'}</td>
                  <td className="gw-actions"><button type="button" className="btn-secondary-small" onClick={() => setTrunk({ ...t, password: '' })}>Editar</button> <button type="button" className="btn-secondary-small" onClick={() => removeTrunk(t)}>Remover</button></td></tr>
              ))}
              {trunks.length === 0 && <tr><td colSpan={4}>Nenhum tronco cadastrado.</td></tr>}
            </tbody>
          </table>
          {!trunk && <button type="button" className="btn-primary" onClick={() => setTrunk({ ...emptyTrunk })}>+ Cadastrar tronco SIP</button>}
          {trunk && (
            <form onSubmit={saveTrunk} className="gw-form">
              <h3>{trunk.id ? 'Editar tronco' : 'Novo tronco SIP'}</h3>
              <label>Nome</label><input value={trunk.name} onChange={setT('name')} required />
              <div className="gw-row">
                <div><label>Servidor SIP</label><input value={trunk.host} onChange={setT('host')} placeholder="sip.fornecedor.com.br" required /></div>
                <div><label>Porta</label><input type="number" value={trunk.port} onChange={setT('port')} /></div>
                <div><label>Transporte</label><select value={trunk.transport} onChange={setT('transport')}><option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option></select></div>
              </div>
              <div className="gw-row">
                <div><label>Usuário</label><input value={trunk.username || ''} onChange={setT('username')} autoComplete="off" /></div>
                <div><label>Senha {trunk.hasPassword && '(vazio = manter)'}</label><input type="password" value={trunk.password} onChange={setT('password')} autoComplete="new-password" /></div>
              </div>
              <label><input type="checkbox" checked={trunk.register} onChange={setT('register')} /> O fornecedor exige registro (usuário e senha)</label>
              <div className="gw-row">
                <div><label>Número de saída (identificador de chamadas)</label><input value={trunk.outboundCallerId || ''} onChange={setT('outboundCallerId')} placeholder="551140001234" /></div>
                <div><label>Prefixo para discar (se o fornecedor pedir)</label><input value={trunk.dialPrefix || ''} onChange={setT('dialPrefix')} /></div>
                <div><label>Codecs</label><input value={trunk.codecs} onChange={setT('codecs')} /></div>
              </div>
              <label>Domínio "from" (só se o fornecedor exigir)</label><input value={trunk.fromDomain || ''} onChange={setT('fromDomain')} />
              <div className="gw-actions"><button className="btn-primary" type="submit">Salvar</button> <button type="button" className="btn-secondary-small" onClick={() => setTrunk(null)}>Cancelar</button></div>
            </form>
          )}
          <h4 className="subsection-title">Configuração do Asterisk</h4>
          <button type="button" className="btn-secondary-small" onClick={genAsterisk} disabled={trunks.length === 0}>Gerar arquivos</button>
          {asterisk && (
            <>
              <p className="hint-text">Contém a senha do tronco: guarde com cuidado.</p>
              <button type="button" className="btn-secondary-small" onClick={() => download('pjsip_turbo.conf', asterisk.pjsip)}>⬇️ pjsip_turbo.conf</button>{' '}
              <button type="button" className="btn-secondary-small" onClick={() => download('extensions_turbo.conf', asterisk.extensions)}>⬇️ extensions_turbo.conf</button>
              <pre className="gw-pre">{asterisk.pjsip}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
