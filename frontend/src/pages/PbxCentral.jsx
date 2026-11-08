// frontend/src/pages/PbxCentral.jsx
// Telefonia PBX nativa: rotas de entrada, URA, filas, áudios, chamadas/gravações e instalação no Asterisk.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import PbxNumeros from '../components/pbx/PbxNumeros';
import './PbxCentral.css';

const TABS = [
  ['rotas', '📥 Rotas de entrada'],
  ['ura', '🎛️ URA (menu de voz)'],
  ['filas', '👥 Filas de atendimento'],
  ['audios', '🔊 Áudios'],
  ['aovivo', '🔴 Ao vivo'],
  ['chamadas', '🎙️ Chamadas e gravações'],
  ['numeros', '📞 Números (admin)'],
  ['vozes', '🗣️ Vozes e fala'],
  ['instalar', '⚙️ Instalação e IA']
];
const DAYS = [['mon', 'Seg'], ['tue', 'Ter'], ['wed', 'Qua'], ['thu', 'Qui'], ['fri', 'Sex'], ['sat', 'Sáb'], ['sun', 'Dom']];
const STRATEGIES = [
  ['rrmemory', 'Rodízio (revezando entre todos)'],
  ['ringall', 'Tocar em todos ao mesmo tempo'],
  ['leastrecent', 'Quem atendeu há mais tempo'],
  ['fewestcalls', 'Quem atendeu menos chamadas'],
  ['linear', 'Sempre na ordem da lista'],
  ['random', 'Aleatório']
];
const STATUS = { atendida: '✅ Atendida', perdida: '❌ Perdida', recado: '📮 Recado', nao_atendida: '📵 Não atendida' };
const DIR = { entrada: '⬇️ Recebida', saida: '⬆️ Feita', ia: '🤖 IA' };
const errText = (e) => e.response?.data?.error || e.message || 'Erro';
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');
const emptyHours = () => ({ enabled: false, tz: 'America/Sao_Paulo', days: Object.fromEntries(DAYS.map(([k]) => [k, ['mon', 'tue', 'wed', 'thu', 'fri'].includes(k) ? [['09:00', '18:00']] : []])) });

function DestPicker({ value, onChange, data, allow = ['queue', 'ivr', 'extension', 'number', 'voicemail', 'conference', 'ai', 'hangup'] }) {
  const v = value || { type: 'hangup' };
  const LABEL = { queue: 'Fila de atendimento', ivr: 'URA (menu)', extension: 'Ramal de uma pessoa', number: 'Número externo', voicemail: 'Caixa de recados', conference: 'Sala de conferência', ai: 'Atendente de IA (voz)', hangup: 'Desligar' };
  return (
    <span className="pbx-dest">
      <select value={v.type} onChange={(e) => onChange({ type: e.target.value })}>
        {allow.map((t) => <option key={t} value={t}>{LABEL[t]}</option>)}
      </select>
      {v.type === 'queue' && (
        <select value={v.id || ''} onChange={(e) => onChange({ ...v, id: e.target.value })}>
          <option value="">— escolha —</option>
          {data.queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
      )}
      {v.type === 'ivr' && (
        <select value={v.id || ''} onChange={(e) => onChange({ ...v, id: e.target.value })}>
          <option value="">— escolha —</option>
          {data.ivrs.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
      )}
      {v.type === 'extension' && (
        <select value={v.id || ''} onChange={(e) => onChange({ ...v, id: e.target.value })}>
          <option value="">— escolha —</option>
          {data.members.map((m) => <option key={m.memberId} value={m.memberId}>{m.name} ({m.extension})</option>)}
        </select>
      )}
      {v.type === 'number' && <input placeholder="5511999998888" value={v.value || ''} onChange={(e) => onChange({ ...v, value: e.target.value })} />}
      {v.type === 'conference' && <input placeholder="Nº da sala (ex.: 1)" value={v.value || ''} onChange={(e) => onChange({ ...v, value: e.target.value })} />}
    </span>
  );
}

function AudioSelect({ value, onChange, audios, kind, empty = '— sem áudio —' }) {
  const list = audios.filter((a) => !kind || a.kind === kind);
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {list.map((a) => <option key={a.id} value={a.id}>{a.name} ({Math.round(a.durationMs / 1000)}s)</option>)}
    </select>
  );
}

export default function PbxCentral() {
  const isPlatform = (() => { try { return Boolean(JSON.parse(localStorage.getItem('mdv_user') || '{}').isPlatformAdmin); } catch { return false; } })();
  const [tab, setTab] = useState('rotas');
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [route, setRoute] = useState(null);
  const [ivr, setIvr] = useState(null);
  const [queue, setQueue] = useState(null);
  const [calls, setCalls] = useState([]);
  const [filter, setFilter] = useState({ direction: '', q: '' });
  const [player, setPlayer] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [applyRes, setApplyRes] = useState(null);
  const [upload, setUpload] = useState({ name: '', kind: 'prompt' });
  const [tts, setTts] = useState({ name: '', text: '' });
  const fileRef = useRef(null);
  const [engines, setEngines] = useState(null);
  const [engForm, setEngForm] = useState({});
  const [voiceList, setVoiceList] = useState([]);
  const [vt, setVt] = useState({ voice: 'gemini:Kore', text: '' });
  const [sttMsg, setSttMsg] = useState('');

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 7000); };
  const load = useCallback(async () => {
    try { setData((await api.get('/pbx/overview')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, []);
  const loadCalls = useCallback(async () => {
    try { setCalls((await api.get('/pbx/calls', { params: { direction: filter.direction || undefined, q: filter.q || undefined } })).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [filter]);
  const [aiAgents, setAiAgents] = useState([]);
  useEffect(() => { api.get('/ai-calls/agents').then((r) => setAiAgents(Array.isArray(r.data) ? r.data : r.data?.agents || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'chamadas') loadCalls(); }, [tab, loadCalls]);
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (tab !== 'aovivo') return undefined;
    let stop = false;
    const tick = async () => { try { const { data: d } = await api.get('/pbx/live'); if (!stop) setLive(d); } catch (e) { if (!stop) setLive({ available: false, error: errText(e), calls: [], queues: [] }); } };
    tick();
    const t = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [tab]);
  const spy = async (channel, mode) => {
    try { const { data: r } = await api.post('/pbx/live/spy', { channel, mode }); flash(`✅ ${r.message}`); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const hangLive = async (channel) => {
    if (!window.confirm('Derrubar esta chamada?')) return;
    try { await api.post('/pbx/live/hangup', { channel }); flash('✅ Chamada encerrada.'); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  useEffect(() => {
    if (tab !== 'vozes') return;
    api.get('/pbx/voice-engines').then((r) => setEngines(r.data)).catch((e) => flash(`❌ ${errText(e)}`));
    api.get('/ai-calls/options').then((r) => setVoiceList(r.data.voices || [])).catch(() => {});
  }, [tab]);

  const save = async (kind, item, setter) => {
    try {
      const url = `/pbx/${kind}${item.id ? `/${item.id}` : ''}`;
      await api[item.id ? 'put' : 'post'](url, item);
      setter(null);
      await load();
      flash('✅ Salvo. Para valer na central, vá em "Instalação e IA" e clique em Aplicar no Asterisk.');
    } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const del = async (kind, id, label) => {
    if (!window.confirm(`Apagar ${label}?`)) return;
    try { await api.delete(`/pbx/${kind}/${id}`); await load(); } catch (e) { flash(`❌ ${errText(e)}`); }
  };

  const play = async (call, kind) => {
    try {
      const r = await api.get(`/pbx/calls/${call.id}/recording`, { params: { kind }, responseType: 'blob' });
      if (player?.url) URL.revokeObjectURL(player.url);
      setPlayer({ url: URL.createObjectURL(r.data), id: call.id, kind });
    } catch (e) { flash('❌ Gravação não encontrada no servidor.'); }
  };
  const playAudio = async (a) => {
    try {
      const r = await api.get(`/pbx/audios/${a.id}/file`, { responseType: 'blob' });
      if (player?.url) URL.revokeObjectURL(player.url);
      setPlayer({ url: URL.createObjectURL(r.data), id: a.id });
    } catch (e) { flash('❌ Arquivo do áudio não está no servidor.'); }
  };

  const sendAudio = async (e) => {
    e.preventDefault();
    const f = fileRef.current?.files?.[0];
    if (!f) return flash('❌ Escolha um arquivo.');
    const form = new FormData();
    form.append('file', f); form.append('name', upload.name); form.append('kind', upload.kind);
    try { await api.post('/pbx/audios', form); setUpload({ name: '', kind: 'prompt' }); fileRef.current.value = ''; await load(); flash('✅ Áudio enviado.'); } catch (err) { flash(`❌ ${errText(err)}`); }
  };
  const makeTts = async (e) => {
    e.preventDefault();
    try { await api.post('/pbx/audios/tts', tts); setTts({ name: '', text: '' }); await load(); flash('✅ Áudio criado com a voz da IA.'); } catch (err) { flash(`❌ ${errText(err)}`); }
  };


  const saveEngine = async (p) => {
    try {
      await api.put(`/pbx/voice-engines/${p}`, engForm[p] || {});
      setEngForm({ ...engForm, [p]: {} });
      setEngines((await api.get('/pbx/voice-engines')).data);
      flash('✅ Chave salva. Use "Ouvir amostra" para testar.');
    } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const removeEngine = async (p) => {
    if (!window.confirm('Remover as chaves deste fornecedor?')) return;
    try { await api.delete(`/pbx/voice-engines/${p}`); setEngines((await api.get('/pbx/voice-engines')).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const testVoice = async () => {
    try {
      const r = await api.post('/pbx/voices/test', { voice: vt.voice, text: vt.text || undefined }, { responseType: 'blob' });
      if (player?.url) URL.revokeObjectURL(player.url);
      setPlayer({ url: URL.createObjectURL(r.data), id: 'voz' });
    } catch (e) {
      let text = errText(e);
      try { text = JSON.parse(await e.response.data.text()).error || text; } catch (_) { /* mantém */ }
      flash(`❌ ${text}`);
    }
  };
  const testStt = async () => {
    setSttMsg('Testando…');
    try {
      const { data: r } = await api.post('/pbx/voices/stt-test', { voice: vt.voice, provider: data.settings.sttProvider || 'auto' });
      setSttMsg(r.ok ? `✅ Entendeu: "${r.heard}"` : `⚠️ Disse "${r.said}" e entendeu "${r.heard || '(nada)'}"`);
    } catch (e) { setSttMsg(`❌ ${errText(e)}`); }
  };

  const genConfig = async () => { try { setCfg((await api.get('/pbx/config')).data); } catch (e) { flash(`❌ ${errText(e)}`); } };
  const apply = async () => {
    try { setApplyRes((await api.post('/pbx/apply')).data); flash('✅ Arquivos gravados e Asterisk recarregado.'); } catch (e) { setApplyRes(null); flash(`❌ ${errText(e)}`); }
  };
  const download = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const saveSettings = async (patch) => {
    try { const { data: s } = await api.put('/pbx/settings', { ...data.settings, ...patch }); setData({ ...data, settings: s }); flash('✅ Configuração salva.'); } catch (e) { flash(`❌ ${errText(e)}`); }
  };

  if (!data) return <div className="pbx-page"><h1>🏢 Telefonia PBX</h1>{msg ? <p className="pbx-flash">{msg}</p> : <p>Carregando…</p>}</div>;
  const nameOf = { queue: (id) => data.queues.find((x) => x.id === id)?.name, ivr: (id) => data.ivrs.find((x) => x.id === id)?.name, extension: (id) => data.members.find((x) => x.memberId === id)?.name };
  const destText = (d) => {
    if (!d) return '—';
    const t = { queue: `Fila ${nameOf.queue(d.id) || '?'}`, ivr: `URA ${nameOf.ivr(d.id) || '?'}`, extension: `Ramal ${nameOf.extension(d.id) || d.value || '?'}`, number: `Número ${d.value}`, voicemail: 'Caixa de recados', conference: `Sala ${d.value || 1}`, ai: 'Atendente de IA', hangup: 'Desligar' };
    return t[d.type] || d.type;
  };

  return (
    <div className="pbx-page">
      <header>
        <h1>🏢 Telefonia PBX</h1>
        <p>Central telefônica própria: URA, filas de atendimento, horário comercial, gravação das chamadas e ligações da IA — tudo rodando no seu Asterisk, sem Twilio.</p>
      </header>
      {msg && <p className="pbx-flash">{msg}</p>}
      <div className="pbx-tabs">{TABS.filter(([k]) => isPlatform || !['vozes', 'numeros'].includes(k)).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {player && <div className="pbx-player"><audio controls autoPlay src={player.url} /> <button className="btn-secondary-small" onClick={() => setPlayer(null)}>Fechar</button></div>}

      {tab === 'rotas' && (
        <div className="card">
          <h3>Rotas de entrada</h3>
          <p className="hint-text">Dizem o que acontece quando alguém liga para um número seu: cair numa URA, numa fila, num ramal… e o que fazer fora do horário comercial.</p>
          <button className="btn-primary" onClick={() => setRoute({ name: '', trunkId: '', did: '', dest: { type: 'ivr' }, hours: emptyHours(), closedDest: { type: 'voicemail' }, record: true, enabled: true })}>+ Nova rota</button>
          <table className="pbx-table">
            <thead><tr><th>Nome</th><th>Número/tronco</th><th>Destino</th><th>Horário</th><th /></tr></thead>
            <tbody>
              {data.routes.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}{!r.enabled && ' (desligada)'}</td>
                  <td>{r.did || 'qualquer número'} · {data.trunks.find((t) => t.id === r.trunkId)?.name || 'qualquer tronco'}</td>
                  <td>{destText(r.dest)}</td>
                  <td>{r.hours?.enabled ? `Comercial → fora: ${destText(r.closedDest)}` : 'Sempre aberto'}</td>
                  <td className="pbx-actions"><button className="btn-secondary-small" onClick={() => setRoute({ ...r, did: r.did || '', trunkId: r.trunkId || '', hours: r.hours || emptyHours(), closedDest: r.closedDest || { type: 'voicemail' } })}>Editar</button> <button className="btn-secondary-small" onClick={() => del('routes', r.id, 'esta rota')}>Apagar</button></td>
                </tr>
              ))}
              {!data.routes.length && <tr><td colSpan={5}>Nenhuma rota. Sem rota, as ligações tocam em todos os ramais.</td></tr>}
            </tbody>
          </table>
          {route && (
            <form className="pbx-form" onSubmit={(e) => { e.preventDefault(); save('routes', { ...route, trunkId: route.trunkId || null, hours: route.hours?.enabled ? route.hours : null }, setRoute); }}>
              <h4>{route.id ? 'Editar rota' : 'Nova rota'}</h4>
              <label>Nome</label><input value={route.name} onChange={(e) => setRoute({ ...route, name: e.target.value })} required />
              <div className="pbx-row">
                <div><label>Tronco (deixe vazio para qualquer)</label>
                  <select value={route.trunkId} onChange={(e) => setRoute({ ...route, trunkId: e.target.value })}><option value="">Qualquer tronco</option>{data.trunks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                <div><label>Número que o cliente ligou{(data.dids || []).length ? '' : ' (opcional)'}</label>{(data.dids || []).length && !isPlatform ? (<select value={route.did} onChange={(e) => setRoute({ ...route, did: e.target.value })}><option value="">Qualquer um dos meus números</option>{data.dids.map((d) => <option key={d.id} value={d.number}>{d.number}{d.label ? ` — ${d.label}` : ''}</option>)}</select>) : (<input placeholder="551140001234" value={route.did} onChange={(e) => setRoute({ ...route, did: e.target.value })} />)}</div>
              </div>
              <label>Quando estiver aberto, a ligação vai para</label>
              <DestPicker value={route.dest} onChange={(dest) => setRoute({ ...route, dest })} data={data} />
              <label><input type="checkbox" checked={route.hours.enabled} onChange={(e) => setRoute({ ...route, hours: { ...route.hours, enabled: e.target.checked } })} /> Usar horário comercial</label>
              {route.hours.enabled && (
                <div className="pbx-hours">
                  {DAYS.map(([k, l]) => {
                    const r = route.hours.days[k]?.[0];
                    const set = (next) => setRoute({ ...route, hours: { ...route.hours, days: { ...route.hours.days, [k]: next } } });
                    return (
                      <div key={k}>
                        <label><input type="checkbox" checked={!!r} onChange={(e) => set(e.target.checked ? [['09:00', '18:00']] : [])} /> {l}</label>
                        {r && <><input type="time" value={r[0]} onChange={(e) => set([[e.target.value, r[1]]])} /> às <input type="time" value={r[1]} onChange={(e) => set([[r[0], e.target.value]])} /></>}
                      </div>
                    );
                  })}
                  <label>Fora do horário, a ligação vai para</label>
                  <DestPicker value={route.closedDest} onChange={(closedDest) => setRoute({ ...route, closedDest })} data={data} />
                </div>
              )}
              <label><input type="checkbox" checked={route.record} onChange={(e) => setRoute({ ...route, record: e.target.checked })} /> Gravar as chamadas desta rota</label>
              <label><input type="checkbox" checked={route.enabled} onChange={(e) => setRoute({ ...route, enabled: e.target.checked })} /> Rota ligada</label>
              <div className="pbx-actions"><button className="btn-primary" type="submit">Salvar</button> <button type="button" className="btn-secondary-small" onClick={() => setRoute(null)}>Cancelar</button></div>
            </form>
          )}
        </div>
      )}

      {tab === 'ura' && (
        <div className="card">
          <h3>URA — menu de voz ("Digite 1 para vendas…")</h3>
          <button className="btn-primary" onClick={() => setIvr({ name: '', greetingAudioId: null, invalidAudioId: null, timeoutSeconds: 6, maxRetries: 2, options: [], timeoutDest: { type: 'hangup' }, extensionDial: false, enabled: true })}>+ Nova URA</button>
          <table className="pbx-table">
            <thead><tr><th>Nome</th><th>Teclas</th><th /></tr></thead>
            <tbody>
              {data.ivrs.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{(i.options || []).map((o) => `${o.digit} → ${destText(o.dest)}`).join(' · ') || '—'}</td>
                  <td className="pbx-actions"><button className="btn-secondary-small" onClick={() => setIvr({ ...i, timeoutDest: i.timeoutDest || { type: 'hangup' } })}>Editar</button> <button className="btn-secondary-small" onClick={() => del('ivrs', i.id, 'esta URA')}>Apagar</button></td>
                </tr>
              ))}
              {!data.ivrs.length && <tr><td colSpan={3}>Nenhuma URA ainda.</td></tr>}
            </tbody>
          </table>
          {ivr && (
            <form className="pbx-form" onSubmit={(e) => { e.preventDefault(); save('ivrs', ivr, setIvr); }}>
              <h4>{ivr.id ? 'Editar URA' : 'Nova URA'}</h4>
              <label>Nome</label><input value={ivr.name} onChange={(e) => setIvr({ ...ivr, name: e.target.value })} required />
              <label>Áudio de boas-vindas (envie na aba Áudios)</label>
              <AudioSelect audios={data.audios} kind="prompt" value={ivr.greetingAudioId} onChange={(v) => setIvr({ ...ivr, greetingAudioId: v })} />
              <label>Áudio de "opção inválida" (opcional)</label>
              <AudioSelect audios={data.audios} kind="prompt" value={ivr.invalidAudioId} onChange={(v) => setIvr({ ...ivr, invalidAudioId: v })} />
              <div className="pbx-row">
                <div><label>Espera pela tecla (segundos)</label><input type="number" min="2" max="30" value={ivr.timeoutSeconds} onChange={(e) => setIvr({ ...ivr, timeoutSeconds: e.target.value })} /></div>
                <div><label>Repetições do menu</label><input type="number" min="1" max="5" value={ivr.maxRetries} onChange={(e) => setIvr({ ...ivr, maxRetries: e.target.value })} /></div>
              </div>
              <label>Teclas</label>
              {ivr.options.map((o, idx) => (
                <div key={idx} className="pbx-opt">
                  <input className="pbx-digit" maxLength={1} value={o.digit} onChange={(e) => setIvr({ ...ivr, options: ivr.options.map((x, i) => (i === idx ? { ...x, digit: e.target.value } : x)) })} />
                  <DestPicker value={o.dest} data={data} onChange={(dest) => setIvr({ ...ivr, options: ivr.options.map((x, i) => (i === idx ? { ...x, dest } : x)) })} />
                  <button type="button" className="btn-secondary-small" onClick={() => setIvr({ ...ivr, options: ivr.options.filter((_, i) => i !== idx) })}>✕</button>
                </div>
              ))}
              <button type="button" className="btn-secondary-small" onClick={() => setIvr({ ...ivr, options: [...ivr.options, { digit: String((ivr.options.length + 1) % 10), dest: { type: 'queue' } }] })}>+ Tecla</button>
              <label><input type="checkbox" checked={ivr.extensionDial} onChange={(e) => setIvr({ ...ivr, extensionDial: e.target.checked })} /> Permitir digitar o ramal de 4 dígitos</label>
              <label>Se a pessoa não escolher nada (após as repetições)</label>
              <DestPicker value={ivr.timeoutDest} onChange={(timeoutDest) => setIvr({ ...ivr, timeoutDest })} data={data} />
              <div className="pbx-actions"><button className="btn-primary" type="submit">Salvar</button> <button type="button" className="btn-secondary-small" onClick={() => setIvr(null)}>Cancelar</button></div>
            </form>
          )}
        </div>
      )}

      {tab === 'filas' && (
        <div className="card">
          <h3>Filas de atendimento</h3>
          <p className="hint-text">Os clientes aguardam na linha (com música) até um atendente livre. Os atendentes usam o Telefone no navegador.</p>
          <button className="btn-primary" onClick={() => setQueue({ name: '', strategy: 'rrmemory', ringSeconds: 20, maxWaitSeconds: 300, wrapupSeconds: 5, mohAudioId: null, announceHoldtime: false, joinEmpty: false, members: [], overflowDest: { type: 'voicemail' }, enabled: true })}>+ Nova fila</button>
          <table className="pbx-table">
            <thead><tr><th>Nome</th><th>Atendentes</th><th>Se ninguém atender</th><th /></tr></thead>
            <tbody>
              {data.queues.map((q) => (
                <tr key={q.id}>
                  <td>{q.name}</td><td>{(q.members || []).map((m) => m.name).join(', ') || '—'}</td><td>{destText(q.overflowDest)}</td>
                  <td className="pbx-actions"><button className="btn-secondary-small" onClick={() => setQueue({ ...q, overflowDest: q.overflowDest || { type: 'voicemail' } })}>Editar</button> <button className="btn-secondary-small" onClick={() => del('queues', q.id, 'esta fila')}>Apagar</button></td>
                </tr>
              ))}
              {!data.queues.length && <tr><td colSpan={4}>Nenhuma fila ainda.</td></tr>}
            </tbody>
          </table>
          {queue && (
            <form className="pbx-form" onSubmit={(e) => { e.preventDefault(); save('queues', queue, setQueue); }}>
              <h4>{queue.id ? 'Editar fila' : 'Nova fila'}</h4>
              <label>Nome</label><input value={queue.name} onChange={(e) => setQueue({ ...queue, name: e.target.value })} required />
              <label>Quem toca primeiro</label>
              <select value={queue.strategy} onChange={(e) => setQueue({ ...queue, strategy: e.target.value })}>{STRATEGIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <label>Atendentes</label>
              <div className="pbx-members">
                {data.members.map((m) => (
                  <label key={m.memberId}><input type="checkbox" checked={queue.members.some((x) => x.memberId === m.memberId)} onChange={(e) => setQueue({ ...queue, members: e.target.checked ? [...queue.members, { memberId: m.memberId }] : queue.members.filter((x) => x.memberId !== m.memberId) })} /> {m.name} ({m.extension})</label>
                ))}
              </div>
              <div className="pbx-row">
                <div><label>Tempo tocando em cada atendente (s)</label><input type="number" value={queue.ringSeconds} onChange={(e) => setQueue({ ...queue, ringSeconds: e.target.value })} /></div>
                <div><label>Espera máxima do cliente (s)</label><input type="number" value={queue.maxWaitSeconds} onChange={(e) => setQueue({ ...queue, maxWaitSeconds: e.target.value })} /></div>
                <div><label>Pausa entre chamadas (s)</label><input type="number" value={queue.wrapupSeconds} onChange={(e) => setQueue({ ...queue, wrapupSeconds: e.target.value })} /></div>
              </div>
              <label>Música de espera (envie na aba Áudios como "Música de espera")</label>
              <AudioSelect audios={data.audios} kind="moh" empty="— música padrão do Asterisk —" value={queue.mohAudioId} onChange={(v) => setQueue({ ...queue, mohAudioId: v })} />
              <label><input type="checkbox" checked={queue.announceHoldtime} onChange={(e) => setQueue({ ...queue, announceHoldtime: e.target.checked })} /> Avisar o tempo estimado de espera</label>
              <label><input type="checkbox" checked={queue.joinEmpty} onChange={(e) => setQueue({ ...queue, joinEmpty: e.target.checked })} /> Aceitar clientes mesmo sem atendente conectado</label>
              <label>Se ninguém atender no tempo máximo</label>
              <DestPicker value={queue.overflowDest} onChange={(overflowDest) => setQueue({ ...queue, overflowDest })} data={data} allow={['ivr', 'extension', 'number', 'voicemail', 'hangup']} />
              <div className="pbx-actions"><button className="btn-primary" type="submit">Salvar</button> <button type="button" className="btn-secondary-small" onClick={() => setQueue(null)}>Cancelar</button></div>
            </form>
          )}
        </div>
      )}

      {tab === 'audios' && (
        <div className="card">
          <h3>Áudios (saudações, avisos e música de espera)</h3>
          <form className="pbx-form" onSubmit={sendAudio}>
            <h4>Enviar arquivo</h4>
            <p className="hint-text">Aceita WAV direto; MP3/OGG/M4A precisam do ffmpeg no servidor. É convertido sozinho para o formato do telefone.</p>
            <input value={upload.name} onChange={(e) => setUpload({ ...upload, name: e.target.value })} placeholder="Nome (ex.: Boas-vindas)" />
            <select value={upload.kind} onChange={(e) => setUpload({ ...upload, kind: e.target.value })}><option value="prompt">Locução / aviso</option><option value="moh">Música de espera</option></select>
            <input type="file" accept="audio/*" ref={fileRef} />
            <button className="btn-primary" type="submit">Enviar</button>
          </form>
          <form className="pbx-form" onSubmit={makeTts}>
            <h4>Criar a partir de texto (voz da IA)</h4>
            <input value={tts.name} onChange={(e) => setTts({ ...tts, name: e.target.value })} placeholder="Nome" />
            <textarea rows={3} value={tts.text} onChange={(e) => setTts({ ...tts, text: e.target.value })} placeholder="Olá! Você ligou para a Empresa X. Para vendas, digite 1…" required />
            <button className="btn-primary" type="submit">Gerar áudio</button>
          </form>
          <table className="pbx-table">
            <thead><tr><th>Nome</th><th>Tipo</th><th>Duração</th><th /></tr></thead>
            <tbody>
              {data.audios.map((a) => (
                <tr key={a.id}><td>{a.name}</td><td>{a.kind === 'moh' ? 'Música de espera' : 'Locução'}</td><td>{Math.round(a.durationMs / 1000)}s</td>
                  <td className="pbx-actions"><button className="btn-secondary-small" onClick={() => playAudio(a)}>▶️ Ouvir</button> <button className="btn-secondary-small" onClick={() => del('audios', a.id, 'este áudio')}>Apagar</button></td></tr>
              ))}
              {!data.audios.length && <tr><td colSpan={4}>Nenhum áudio.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'numeros' && isPlatform && <PbxNumeros flash={flash} />}

      {tab === 'aovivo' && (
        <div className="card">
          <h3>Chamadas em andamento</h3>
          {live && !live.available && <p className="hint-text">⚠️ {live.error}</p>}
          <table className="pbx-table">
            <thead><tr><th>Quem</th><th>Número</th><th>Estado</th><th>Tempo</th><th>Supervisão</th></tr></thead>
            <tbody>
              {(live?.calls || []).map((c) => (
                <tr key={c.channel}>
                  <td>{c.who || c.channel}</td><td>{c.callerId}</td><td>{c.state}{c.app ? ` · ${c.app}` : ''}</td>
                  <td>{Math.floor(c.seconds / 60)}:{String(c.seconds % 60).padStart(2, '0')}</td>
                  <td>{c.spyable ? <>
                    <button type="button" className="btn-secondary-small" onClick={() => spy(c.channel, 'listen')}>👂 Escutar</button>{' '}
                    <button type="button" className="btn-secondary-small" onClick={() => spy(c.channel, 'whisper')}>🤫 Sussurrar</button>{' '}
                    <button type="button" className="btn-secondary-small" onClick={() => spy(c.channel, 'barge')}>🎤 Entrar</button>{' '}
                    <button type="button" className="btn-secondary-small" onClick={() => hangLive(c.channel)}>⛔ Derrubar</button></> : '—'}</td>
                </tr>
              ))}
              {live && !live.calls.length && <tr><td colSpan={5}>Nenhuma chamada agora.</td></tr>}
            </tbody>
          </table>
          <p className="hint-text">Ao clicar, o seu ramal toca (deixe a tela Telefone SIP aberta e atenda): "Escutar" só ouve; "Sussurrar" fala só com o vendedor; "Entrar" fala com os dois. Avise a equipe que a supervisão existe.</p>
          <h3>Filas</h3>
          {(live?.queues || []).map((q) => (
            <div key={q.name} className="pbx-queue-live">
              <strong>{q.label}</strong> — {q.waiting} esperando
              <div>{q.members.map((m) => <span key={m.member} className="pbx-chip">{m.member}: {m.status}{m.paused ? ' (pausado)' : ''}</span>)}</div>
              {q.callers.map((c) => <div key={c.channel}>⏳ {c.channel} aguardando {c.wait}</div>)}
            </div>
          ))}
          {live && !live.queues.length && <p className="hint-text">Sem filas ativas.</p>}
        </div>
      )}

      {tab === 'chamadas' && (
        <div className="card">
          <h3>Chamadas e gravações</h3>
          <div className="pbx-row">
            <select value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value })}><option value="">Todas</option><option value="entrada">Recebidas</option><option value="saida">Feitas</option><option value="ia">Da IA</option></select>
            <input placeholder="Buscar número" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
            <button className="btn-secondary-small" onClick={loadCalls}>Atualizar</button>
          </div>
          <table className="pbx-table">
            <thead><tr><th>Quando</th><th>Tipo</th><th>De</th><th>Para</th><th>Situação</th><th>Duração</th><th>Fila</th><th /></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.startedAt).toLocaleString('pt-BR')}</td><td>{DIR[c.direction] || c.direction}</td><td>{c.fromNumber || '—'}</td><td>{c.toNumber || '—'}</td>
                  <td>{STATUS[c.status] || c.status}</td><td>{fmtDur(c.durationSeconds)}</td><td>{c.queueName || '—'}</td>
                  <td className="pbx-actions">
                    {c.hasRecording && <button className="btn-secondary-small" onClick={() => play(c, 'recording')}>▶️ Gravação</button>}
                    {c.hasVoicemail && <button className="btn-secondary-small" onClick={() => play(c, 'voicemail')}>📮 Recado</button>}
                  </td>
                </tr>
              ))}
              {!calls.length && <tr><td colSpan={8}>Nenhuma chamada registrada ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'vozes' && (
        <div className="card">
          <h3>Vozes e reconhecimento de fala (ligações da IA pelo PBX nativo)</h3>
          <p className="hint-text">A voz que a IA usa na ligação é escolhida no cadastro do Agente de IA (as vozes novas aparecem lá com a marca "só no PBX nativo"). Aqui você cadastra as chaves de cada fornecedor e testa. Gemini e OpenAI usam as chaves de Configurações → Inteligência Artificial.</p>
          {engines && [
            ['google', 'Google Cloud (vozes Chirp/Neural2 e fala→texto)', [['apiKey', 'Chave da API do Google Cloud (vazio = usa a do Gemini)', 'password']], 'Ative no Google Cloud: Cloud Text-to-Speech API e Speech-to-Text API.'],
            ['azure', 'Microsoft Azure Speech (vozes e fala→texto)', [['apiKey', 'Chave do recurso Speech', 'password'], ['region', 'Região (ex.: brazilsouth, eastus)', 'text']], 'Crie um recurso "Speech" no portal Azure e copie Chave 1 e a Região.'],
            ['polly', 'Amazon Polly (vozes)', [['accessKeyId', 'Access Key ID da AWS', 'text'], ['secret', 'Secret Access Key da AWS', 'password'], ['region', 'Região (ex.: us-east-1, sa-east-1)', 'text']], 'Crie um usuário IAM só com a permissão AmazonPollyReadOnlyAccess. (Vozes neurais pt-BR: Camila, Vitória, Thiago.)'],
            ['elevenlabs', 'ElevenLabs (vozes)', [['apiKey', 'Chave da API (xi-api-key)', 'password']], 'O ID da voz vai no cadastro do agente como elevenlabs:IDDAVOZ.']
          ].map(([p, title, fields, hint]) => (
            <div key={p} className="pbx-form">
              <h4>{title} {engines[p]?.configured ? '✅ configurado' : ''}</h4>
              <p className="hint-text">{hint}</p>
              {fields.map(([f, label, type]) => (
                <div key={f}>
                  <label>{label}</label>
                  <input type={type} autoComplete="off" placeholder={engines[p]?.values?.hints?.[f] || engines[p]?.values?.values?.[f] || ''} value={engForm[p]?.[f] || ''} onChange={(e) => setEngForm({ ...engForm, [p]: { ...(engForm[p] || {}), [f]: e.target.value } })} />
                </div>
              ))}
              <div className="pbx-actions"><button className="btn-primary" onClick={() => saveEngine(p)}>Salvar</button>{engines[p]?.configured && <button className="btn-secondary-small" onClick={() => removeEngine(p)}>Remover</button>}</div>
            </div>
          ))}
          <h4>Ouvir amostra</h4>
          <p className="hint-text">Toca como o telefone recebe (qualidade de ligação).</p>
          <select value={vt.voice} onChange={(e) => setVt({ ...vt, voice: e.target.value })}>
            {voiceList.map((v) => <option key={v.id} value={v.id}>{v.group ? `${v.group} — ` : ''}{v.label}</option>)}
            {!voiceList.length && <option value="gemini:Kore">gemini:Kore</option>}
          </select>
          <textarea rows={2} placeholder="Texto para ouvir (opcional)" value={vt.text} onChange={(e) => setVt({ ...vt, text: e.target.value })} />
          <div className="pbx-actions"><button className="btn-primary" onClick={testVoice}>▶️ Ouvir amostra</button></div>
          <h4>Reconhecimento de fala (o que o cliente diz)</h4>
          <select value={data.settings.sttProvider || 'auto'} onChange={(e) => saveSettings({ sttProvider: e.target.value })}>
            <option value="auto">Automático (Gemini; se falhar, OpenAI Whisper)</option>
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI Whisper</option>
            <option value="google">Google Cloud Speech-to-Text</option>
            <option value="azure">Microsoft Azure Speech</option>
          </select>
          <div className="pbx-actions"><button className="btn-secondary-small" onClick={testStt}>Testar reconhecimento</button> <span>{sttMsg}</span></div>
          <p className="hint-text">O teste usa a voz escolhida acima para falar uma frase e o motor escolhido para transcrever. Amazon Transcribe não está disponível (exige transmissão contínua).</p>
        </div>
      )}

      {tab === 'instalar' && (
        <div className="card">
          <h3>Configurações do PBX</h3>
          <label><input type="checkbox" checked={data.settings.recordInbound !== 'false'} onChange={(e) => saveSettings({ recordInbound: e.target.checked })} /> Gravar chamadas recebidas</label>
          <label><input type="checkbox" checked={data.settings.recordOutbound !== 'false'} onChange={(e) => saveSettings({ recordOutbound: e.target.checked })} /> Gravar chamadas feitas pelos vendedores</label>
          <p className="hint-text">Avise o cliente que a ligação pode ser gravada (exigência comum no Brasil — grave um aviso na aba Áudios e coloque no começo da URA).</p>
          <h4>Ligações da IA</h4>
          <p className="hint-text">Para a IA ligar pelo Asterisk, escolha "Asterisk (PBX próprio)" em Configurações → Telefonia das ligações da IA. Quando a IA decidir passar para um humano, a ligação vai para esta fila (ou, sem fila, para o telefone do vendedor).</p>
          <select value={data.settings.aiHandoffQueueId || ''} onChange={(e) => saveSettings({ aiHandoffQueueId: e.target.value })}>
            <option value="">Transferir para o número do vendedor</option>
            {data.queues.map((q) => <option key={q.id} value={q.id}>Fila: {q.name}</option>)}
          </select>
          <h4>IA atendendo ligações recebidas</h4>
          <p className="hint-text">Escolha o agente que atende quando uma rota de entrada (ou opção da URA) apontar para "Atendente de IA". Cada pessoa que ligar vira um lead (ou é reconhecida pelo telefone) e a conversa fica no histórico.</p>
          <select value={data.settings.aiInboundAgentId || ''} onChange={(e) => saveSettings({ aiInboundAgentId: e.target.value })}>
            <option value="">— nenhum agente —</option>
            {aiAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <label>Saudação ao atender (opcional; use {'{agente}'} e {'{empresa}'})</label>
          <input defaultValue={data.settings.aiInboundGreeting || ''} placeholder="Olá, aqui é a {agente} da {empresa}. Como posso ajudar?" onBlur={(e) => { if (e.target.value !== (data.settings.aiInboundGreeting || '')) saveSettings({ aiInboundGreeting: e.target.value }); }} />
          <h4>Aplicar no Asterisk</h4>
          <p className="hint-text">Depois de fazer a instalação única do guia, o botão abaixo grava os arquivos e manda o Asterisk recarregar (as chamadas em andamento não caem).</p>
          <button className="btn-primary" onClick={apply}>Aplicar no Asterisk</button>
          {applyRes && (
            <div className="hint-text">
              <p>Arquivos: {applyRes.files.join(', ')}</p>
              {applyRes.warnings?.map((w) => <p key={w}>⚠️ {w}</p>)}
              {applyRes.reload.map((r) => <p key={r.cmd}>{r.ok ? '✅' : '❌'} {r.cmd}{!r.ok && r.out ? ` — ${r.out}` : ''}</p>)}
            </div>
          )}
          {isPlatform && <h4>Instalar à mão (alternativa)</h4>}
          {isPlatform && <button className="btn-secondary-small" onClick={genConfig}>Gerar arquivos para baixar</button>}
          {isPlatform && cfg && (
            <>
              <p className="hint-text">Contém senhas: guarde com cuidado. {cfg.warnings.map((w) => `⚠️ ${w}`).join(' ')}</p>
              <div className="pbx-actions">
                {[['pjsip_turbo_transports.conf', cfg.transports], [`pjsip_turbo_${cfg.tag}.conf`, cfg.pjsip], ['extensions_turbo_shared.conf', cfg.shared], [`extensions_turbo_${cfg.tag}.conf`, cfg.extensions], [`queues_turbo_${cfg.tag}.conf`, cfg.queues], [`musiconhold_turbo_${cfg.tag}.conf`, cfg.moh]].map(([n, t]) => (
                  <button key={n} className="btn-secondary-small" onClick={() => download(n, t)}>⬇️ {n}</button>
                ))}
              </div>
              <pre className="pbx-pre">{cfg.extensions}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
