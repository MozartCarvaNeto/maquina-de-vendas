// frontend/src/pages/RoboLigacoes.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './RoboLigacoes.css';

const STATUS_LABEL = {
  rascunho: 'Rascunho',
  discando: '📞 Discando',
  pausado: '⏸️ Pausada',
  concluido: '✅ Concluída'
};

// Uma URL de pré-escuta por arquivo (evita recriar a cada renderização).
const previewUrls = new WeakMap();
function previewUrl(file) {
  if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
  return previewUrls.get(file);
}

function emptyForm() {
  return {
    name: '',
    audienceType: 'all',
    audienceListId: '',
    audienceStatus: '',
    digitInterested: '1',
    digitNotInterested: '2',
    useSpeechRecognition: true,
    crmColumnId: '',
    whatsappFollowupMessage: 'Olá {{nome}}! Aqui é da nossa equipe. Você demonstrou interesse na nossa ligação, então vamos continuar seu atendimento por aqui. Posso te explicar melhor?',
    callerNumberId: '',
    recordCallsEnabled: false,
    concurrency: 1,
    minDelaySeconds: 15,
    maxDelaySeconds: 40,
    introAudio: null,
    interestedAudio: null,
    notInterestedAudio: null
  };
}

export default function RoboLigacoes() {
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists] = useState([]);
  const [columns, setColumns] = useState([]);
  const [callerNumbers, setCallerNumbers] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [audienceCount, setAudienceCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [callsByCampaign, setCallsByCampaign] = useState({});

  const loadCampaigns = useCallback(async () => {
    const { data } = await api.get('/robocalls');
    setCampaigns(data.campaigns);
  }, []);

  const loadOptions = useCallback(async () => {
    const [listsRes, boardsRes, numbersRes] = await Promise.all([
      api.get('/lead-lists'),
      api.get('/crm/boards').catch(() => ({ data: { boards: [] } })), // plano sem CRM
      api.get('/lines/caller-numbers').catch(() => ({ data: { callerNumbers: [] } }))
    ]);
    setLists(listsRes.data.lists);
    setCallerNumbers(numbersRes.data.callerNumbers.filter((n) => n.isActive));

    const allColumns = [];
    for (const board of boardsRes.data.boards) {
      const { data } = await api.get(`/crm/boards/${board.id}`);
      (data.board.columns || []).forEach((c) => allColumns.push({ id: c.id, label: `${board.name} › ${c.name}` }));
    }
    setColumns(allColumns);
  }, []);

  const loadCalls = useCallback(async (campaignId) => {
    const { data } = await api.get(`/robocalls/${campaignId}/calls`);
    setCallsByCampaign((prev) => ({ ...prev, [campaignId]: data.calls }));
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadOptions();
  }, [loadCampaigns, loadOptions]);

  // Atualiza os números a cada 10s enquanto houver campanha discando e a aba
  // estiver visível. Depende só de "há campanha rodando?" (booleano); antes
  // dependia do array inteiro, que muda a cada recarga e reiniciava o efeito.
  const hasRunning = campaigns.some((c) => c.status === 'discando');
  useEffect(() => {
    if (!hasRunning && !expandedId) return undefined;
    const timer = setInterval(() => {
      if (document.hidden) return;
      loadCampaigns();
      if (expandedId) loadCalls(expandedId);
    }, 10000);
    return () => clearInterval(timer);
  }, [hasRunning, expandedId, loadCampaigns, loadCalls]);

  function buildAudienceFilter() {
    if (form.audienceType === 'list' && form.audienceListId) return { listId: form.audienceListId };
    if (form.audienceType === 'status' && form.audienceStatus) return { status: form.audienceStatus };
    return { all: true };
  }

  async function previewAudience() {
    try {
      const { data } = await api.post('/robocalls/preview-audience', { audienceFilter: buildAudienceFilter() });
      setAudienceCount(data.total);
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível calcular o público.');
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.introAudio) return alert('Envie o áudio principal da ligação.');
    setSaving(true);

    const formData = new FormData();
    formData.append('name', form.name);
    formData.append('audienceFilter', JSON.stringify(buildAudienceFilter()));
    formData.append('digitInterested', form.digitInterested);
    formData.append('digitNotInterested', form.digitNotInterested);
    formData.append('useSpeechRecognition', String(form.useSpeechRecognition));
    formData.append('whatsappFollowupMessage', form.whatsappFollowupMessage);
    formData.append('recordCallsEnabled', String(form.recordCallsEnabled));
    formData.append('concurrency', String(form.concurrency));
    formData.append('minDelaySeconds', String(form.minDelaySeconds));
    formData.append('maxDelaySeconds', String(form.maxDelaySeconds));
    if (form.crmColumnId) formData.append('crmColumnId', form.crmColumnId);
    if (form.callerNumberId) formData.append('callerNumberId', form.callerNumberId);
    formData.append('introAudio', form.introAudio);
    if (form.interestedAudio) formData.append('interestedAudio', form.interestedAudio);
    if (form.notInterestedAudio) formData.append('notInterestedAudio', form.notInterestedAudio);

    try {
      await api.post('/robocalls', formData);
      setShowModal(false);
      setForm(emptyForm());
      setAudienceCount(null);
      loadCampaigns();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar campanha');
    } finally {
      setSaving(false);
    }
  }

  async function startCampaign(id) {
    if (!window.confirm('Iniciar as ligações agora? O sistema vai começar a ligar para os leads da lista.')) return;
    try {
      await api.post(`/robocalls/${id}/start`);
      loadCampaigns();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao iniciar');
    }
  }

  async function pauseCampaign(id) {
    await api.post(`/robocalls/${id}/pause`);
    loadCampaigns();
  }

  async function removeCampaign(id) {
    if (!window.confirm('Excluir esta campanha e os áudios enviados?')) return;
    try {
      await api.delete(`/robocalls/${id}`);
      loadCampaigns();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao excluir');
    }
  }

  function toggleResults(id) {
    if (expandedId === id) return setExpandedId(null);
    setExpandedId(id);
    loadCalls(id);
  }

  function resultBadge(call) {
    if (call.qualified === true) return <span className="robo-badge robo-badge-ok">🔥 Interessado</span>;
    if (call.qualified === false) return <span className="robo-badge robo-badge-no">Sem interesse</span>;
    if (['ocupado', 'falhou', 'sem_resposta'].includes(call.status)) return <span className="robo-badge robo-badge-muted">Não atendeu</span>;
    if (call.status === 'encerrada') return <span className="robo-badge robo-badge-muted">Sem resposta</span>;
    return <span className="robo-badge robo-badge-muted">Em andamento…</span>;
  }

  // Função comum (não componente): assim o campo de arquivo não é recriado a cada tecla digitada.
  function audioInput({ label, field, required, help }) {
    return (
      <div className="robo-audio-field">
        <label>{label}{required ? ' *' : ' (opcional)'}</label>
        <input type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" onChange={(e) => setForm({ ...form, [field]: e.target.files[0] || null })} />
        {form[field] && <audio controls src={previewUrl(form[field])} />}
        {help && <small>{help}</small>}
      </div>
    );
  }

  return (
    <div className="robo-page">
      <header className="robo-header">
        <div>
          <h1>🤖 Ligações Robô</h1>
          <p>O robô liga, toca sua mensagem gravada, identifica quem tem interesse e avisa que vai continuar no WhatsApp — o lead vai direto para o CRM.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Nova campanha</button>
      </header>

      <div className="robo-legal">
        ⚖️ Use só com contatos que você tem base para ligar. A gravação deve se identificar como atendimento automatizado, e quem pedir para parar de receber ligações
        (apertando a tecla ou dizendo "pare de ligar") é marcado automaticamente e nunca mais é chamado.
      </div>

      {campaigns.length === 0 ? (
        <div className="robo-empty">Nenhuma campanha ainda. Clique em "Nova campanha" para começar.</div>
      ) : (
        <div className="robo-list">
          {campaigns.map((c) => (
            <div className="robo-card" key={c.id}>
              <div className="robo-card-top">
                <div>
                  <h3>{c.name}</h3>
                  <span className={`robo-status robo-status-${c.status}`}>{STATUS_LABEL[c.status] || c.status}</span>
                  {c.runningNote && c.status !== 'concluido' && <span className="robo-note"> {c.runningNote}</span>}
                </div>
                <div className="robo-actions">
                  {(c.status === 'rascunho' || c.status === 'pausado') && (
                    <button className="btn-primary" onClick={() => startCampaign(c.id)}>{c.status === 'pausado' ? '▶ Retomar' : '▶ Iniciar'}</button>
                  )}
                  {c.status === 'discando' && <button className="btn-secondary-small" onClick={() => pauseCampaign(c.id)}>⏸ Pausar</button>}
                  <button className="btn-secondary-small" onClick={() => toggleResults(c.id)}>{expandedId === c.id ? 'Ocultar resultados' : 'Ver resultados'}</button>
                  <button className="btn-danger-small" onClick={() => removeCampaign(c.id)}>Excluir</button>
                </div>
              </div>

              <div className="robo-stats">
                <div><strong>{c.totalLeads}</strong><span>Leads</span></div>
                <div><strong>{c.calledCount}</strong><span>Ligações feitas</span></div>
                <div><strong className="robo-hot">{c.interestedCount}</strong><span>Interessados</span></div>
                <div><strong>{c.notInterestedCount}</strong><span>Sem interesse</span></div>
                <div><strong>{c.noAnswerCount}</strong><span>Não atenderam</span></div>
              </div>

              {c.totalLeads > 0 && (
                <div className="robo-progress"><div style={{ width: `${Math.min(100, Math.round((c.calledCount / c.totalLeads) * 100))}%` }} /></div>
              )}

              {expandedId === c.id && (
                <table className="robo-table">
                  <thead><tr><th>Lead</th><th>Telefone</th><th>Resultado</th><th>Respondeu</th><th>Duração</th></tr></thead>
                  <tbody>
                    {(callsByCampaign[c.id] || []).map((call) => (
                      <tr key={call.id}>
                        <td>{call.lead?.name}</td>
                        <td>{call.toNumber}</td>
                        <td>{resultBadge(call)}</td>
                        <td>{call.digitsPressed ? `Tecla ${call.digitsPressed}` : call.speechResult ? `"${call.speechResult}"` : '—'}</td>
                        <td>{call.durationSeconds != null ? `${call.durationSeconds}s` : '—'}</td>
                      </tr>
                    ))}
                    {(callsByCampaign[c.id] || []).length === 0 && <tr><td colSpan="5">Nenhuma ligação feita ainda.</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="robo-modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="robo-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Nova campanha de ligações robô</h2>
            <form onSubmit={handleCreate}>
              <label>Nome da campanha</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />

              <h4>1) Quem vai receber as ligações</h4>
              <select value={form.audienceType} onChange={(e) => setForm({ ...form, audienceType: e.target.value })}>
                <option value="all">Todos os leads com telefone</option>
                <option value="list">Uma lista de leads</option>
                <option value="status">Leads por status</option>
              </select>
              {form.audienceType === 'list' && (
                <select value={form.audienceListId} onChange={(e) => setForm({ ...form, audienceListId: e.target.value })} required>
                  <option value="">Selecione a lista</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              {form.audienceType === 'status' && (
                <select value={form.audienceStatus} onChange={(e) => setForm({ ...form, audienceStatus: e.target.value })} required>
                  <option value="">Selecione o status</option>
                  <option value="novo">Novo</option>
                  <option value="qualificado">Qualificado</option>
                  <option value="desqualificado">Desqualificado</option>
                </select>
              )}
              <button type="button" className="btn-secondary-small" onClick={previewAudience}>Ver quantos leads</button>
              {audienceCount !== null && <span className="robo-note"> {audienceCount} lead(s) serão ligados</span>}

              <h4>2) Áudios gravados</h4>
              {audioInput({ label: 'Áudio principal', field: 'introAudio', required: true, help: 'Toca quando o lead atende. Termine com a pergunta, ex: "Se tiver interesse, aperte 1 ou diga sim. Se não, aperte 2."' })}
              {audioInput({ label: 'Áudio "tenho interesse"', field: 'interestedAudio', help: 'Ex: "Perfeito! Vamos continuar seu atendimento pelo WhatsApp." Se vazio, o sistema usa uma voz padrão.' })}
              {audioInput({ label: 'Áudio "sem interesse"', field: 'notInterestedAudio', help: 'Se vazio, o sistema usa uma despedida padrão.' })}

              <h4>3) Como identificar interesse</h4>
              <div className="robo-row">
                <div><label>Tecla "tenho interesse"</label><input maxLength={1} value={form.digitInterested} onChange={(e) => setForm({ ...form, digitInterested: e.target.value })} required /></div>
                <div><label>Tecla "sem interesse"</label><input maxLength={1} value={form.digitNotInterested} onChange={(e) => setForm({ ...form, digitNotInterested: e.target.value })} required /></div>
              </div>
              <label className="robo-check"><input type="checkbox" checked={form.useSpeechRecognition} onChange={(e) => setForm({ ...form, useSpeechRecognition: e.target.checked })} /> Também entender quando o lead responde falando ("sim", "quero", "não quero"…)</label>

              <h4>4) Quando o lead tiver interesse</h4>
              <label>Mover o lead no CRM para</label>
              <select value={form.crmColumnId} onChange={(e) => setForm({ ...form, crmColumnId: e.target.value })}>
                <option value="">Coluna "Qualificado" (padrão)</option>
                {columns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <label>Mensagem automática no WhatsApp (use {'{{nome}}'} para o nome do lead)</label>
              <textarea rows={4} value={form.whatsappFollowupMessage} onChange={(e) => setForm({ ...form, whatsappFollowupMessage: e.target.value })} />

              <h4>5) Ligação</h4>
              <label>Número de saída</label>
              <select value={form.callerNumberId} onChange={(e) => setForm({ ...form, callerNumberId: e.target.value })}>
                <option value="">Alternar entre os números ativos</option>
                {callerNumbers.map((n) => <option key={n.id} value={n.id}>{n.label} — {n.phoneNumber}</option>)}
              </select>
              <div className="robo-row">
                <div><label>Ligações ao mesmo tempo</label><input type="number" min="1" max="5" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} /></div>
                <div><label>Intervalo mín. (s)</label><input type="number" min="0" value={form.minDelaySeconds} onChange={(e) => setForm({ ...form, minDelaySeconds: e.target.value })} /></div>
                <div><label>Intervalo máx. (s)</label><input type="number" min="0" value={form.maxDelaySeconds} onChange={(e) => setForm({ ...form, maxDelaySeconds: e.target.value })} /></div>
              </div>
              <label className="robo-check"><input type="checkbox" checked={form.recordCallsEnabled} onChange={(e) => setForm({ ...form, recordCallsEnabled: e.target.checked })} /> Gravar as ligações (avise na gravação que a chamada pode ser gravada)</label>

              <div className="robo-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Criar campanha'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}