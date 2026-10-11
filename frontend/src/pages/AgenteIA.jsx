// frontend/src/pages/AgenteIA.jsx
//
// 3º sistema de ligação: AGENTE DE VOZ COM IA.
// A IA liga, conversa, qualifica o cliente, consulta o catálogo e só chama o
// vendedor humano quando a venda está pronta.
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import AiAgentEditor from '../components/ai/AiAgentEditor';
import AiAgentSimulator from '../components/ai/AiAgentSimulator';
import AiTranscriptModal, { OUTCOME_LABEL, HANDOFF_LABEL } from '../components/ai/AiTranscriptModal';
import './AgenteIA.css';

const STATUS_LABEL = {
  rascunho: 'Rascunho',
  discando: '📞 Ligando',
  pausado: '⏸️ Pausada',
  concluido: '✅ Concluída'
};

function emptyCampaignForm(agentId = '') {
  return {
    name: '',
    agentId,
    audienceType: 'all',
    audienceListId: '',
    audienceStatus: '',
    callerNumberId: '',
    windowStart: '09:00',
    windowEnd: '18:00',
    weekdaysOnly: true,
    concurrency: 1,
    minDelaySeconds: 20,
    maxDelaySeconds: 60
  };
}

export default function AgenteIA() {
  const [tab, setTab] = useState('campanhas');
  const [options, setOptions] = useState(null);
  const [agents, setAgents] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists] = useState([]);
  const [callerNumbers, setCallerNumbers] = useState([]);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  const [editor, setEditor] = useState(null); // { agentId } | null
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [form, setForm] = useState(emptyCampaignForm());
  const [audienceCount, setAudienceCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [callsByCampaign, setCallsByCampaign] = useState({});
  const [transcriptId, setTranscriptId] = useState(null);
  const [error, setError] = useState('');

  const loadAgents = useCallback(async () => {
    const { data } = await api.get('/ai-calls/agents');
    setAgents(data.agents);
    return data.agents;
  }, []);

  const loadCampaigns = useCallback(async () => {
    const { data } = await api.get('/ai-calls/campaigns');
    setCampaigns(data.campaigns);
  }, []);

  const loadCalls = useCallback(async (campaignId) => {
    const { data } = await api.get(`/ai-calls/campaigns/${campaignId}/calls`);
    setCallsByCampaign((prev) => ({ ...prev, [campaignId]: data.calls }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [opts, agentList] = await Promise.all([api.get('/ai-calls/options'), loadAgents()]);
        setOptions(opts.data);
        await loadCampaigns();
        if (agentList.length === 0) setTab('agentes');

        const [listsRes, numbersRes, aiRes] = await Promise.all([
          api.get('/lead-lists').catch(() => ({ data: { lists: [] } })),
          api.get('/lines/caller-numbers').catch(() => ({ data: { callerNumbers: [] } })),
          api.get('/settings/ai').catch(() => ({ data: { providers: ['?'] } }))
        ]);
        setLists(listsRes.data.lists || []);
        setCallerNumbers((numbersRes.data.callerNumbers || []).filter((n) => n.isActive));
        setAiConfigured((aiRes.data.providers || []).length > 0);
      } catch (err) {
        setError(err.response?.data?.error || 'Não foi possível carregar o Agente IA. Atualize os arquivos do backend e reinicie o servidor.');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAgents, loadCampaigns]);

  // Atualiza os números a cada 10 s enquanto houver campanha ligando e a aba estiver visível.
  const hasRunning = campaigns.some((c) => c.status === 'discando');
  useEffect(() => {
    if (!hasRunning && !expandedId) return undefined;
    const timer = setInterval(() => {
      if (document.hidden) return;
      loadCampaigns().catch(() => null);
      if (expandedId) loadCalls(expandedId).catch(() => null);
    }, 10000);
    return () => clearInterval(timer);
  }, [hasRunning, expandedId, loadCampaigns, loadCalls]);

  // ------------------------------------------------------------ agentes

  async function removeAgent(agent) {
    if (!window.confirm(`Excluir o agente "${agent.name}"?`)) return;
    try {
      await api.delete(`/ai-calls/agents/${agent.id}`);
      loadAgents();
    } catch (err) {
      alert(err.response?.data?.error || 'Não foi possível excluir.');
    }
  }

  // ------------------------------------------------------------ campanhas

  function buildAudienceFilter() {
    if (form.audienceType === 'list' && form.audienceListId) return { listId: form.audienceListId };
    if (form.audienceType === 'status' && form.audienceStatus) return { status: form.audienceStatus };
    return { all: true };
  }

  async function previewAudience() {
    try {
      const { data } = await api.post('/ai-calls/campaigns/preview-audience', { audienceFilter: buildAudienceFilter() });
      setAudienceCount(data.total);
    } catch (err) {
      alert(err.response?.data?.error || 'Não foi possível calcular o público.');
    }
  }

  async function createCampaign(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/ai-calls/campaigns', {
        name: form.name,
        agentId: form.agentId,
        audienceFilter: buildAudienceFilter(),
        callerNumberId: form.callerNumberId || null,
        windowStart: form.windowStart,
        windowEnd: form.windowEnd,
        weekdaysOnly: form.weekdaysOnly,
        concurrency: Number(form.concurrency),
        minDelaySeconds: Number(form.minDelaySeconds),
        maxDelaySeconds: Number(form.maxDelaySeconds)
      });
      setShowCampaignModal(false);
      setForm(emptyCampaignForm(agents[0]?.id));
      setAudienceCount(null);
      loadCampaigns();
    } catch (err) {
      alert(err.response?.data?.error || 'Erro ao criar a campanha.');
    } finally {
      setSaving(false);
    }
  }

  async function startCampaign(id) {
    if (!window.confirm('Iniciar as ligações agora? A IA vai começar a ligar para os leads da campanha, dentro do horário permitido.')) return;
    try {
      await api.post(`/ai-calls/campaigns/${id}/start`);
      loadCampaigns();
    } catch (err) {
      alert(err.response?.data?.error || 'Erro ao iniciar.');
    }
  }

  async function pauseCampaign(id) {
    await api.post(`/ai-calls/campaigns/${id}/pause`);
    loadCampaigns();
  }

  async function removeCampaign(id) {
    if (!window.confirm('Excluir esta campanha? O histórico das ligações continua salvo nos leads.')) return;
    try {
      await api.delete(`/ai-calls/campaigns/${id}`);
      loadCampaigns();
    } catch (err) {
      alert(err.response?.data?.error || 'Erro ao excluir.');
    }
  }

  function toggleResults(id) {
    if (expandedId === id) return setExpandedId(null);
    setExpandedId(id);
    loadCalls(id);
  }

  function openCampaignModal() {
    if (agents.length === 0) {
      alert('Crie um agente de IA primeiro (aba “Agentes”).');
      setTab('agentes');
      return;
    }
    setForm(emptyCampaignForm(agents[0].id));
    setAudienceCount(null);
    setShowCampaignModal(true);
  }

  function resultBadge(call) {
    const session = call.aiSession;
    if (session?.outcome) {
      return <span className={`ia-badge ia-badge-${session.outcome}`}>{OUTCOME_LABEL[session.outcome] || session.outcome}</span>;
    }
    if (['ocupado', 'falhou', 'sem_resposta'].includes(call.status)) return <span className="ia-badge ia-badge-sem_resposta">Não atendeu</span>;
    if (call.status === 'encerrada') return <span className="ia-badge ia-badge-sem_conclusao">Encerrada</span>;
    return <span className="ia-badge ia-badge-info">Em andamento…</span>;
  }

  if (loading) return <div className="ia-page"><p className="ia-muted">Carregando…</p></div>;

  return (
    <div className="ia-page">
      <header className="ia-header">
        <div>
          <h1>🧠 Agente IA de ligação</h1>
          <p>A IA liga para centenas de contatos, conversa, qualifica o cliente, consulta o catálogo e só chama o vendedor quando a venda está pronta.</p>
        </div>
      </header>

      {error && <div className="ia-alert ia-alert-error">{error}</div>}
      {!aiConfigured && (
        <div className="ia-alert ia-alert-error">
          Nenhuma IA configurada. Cadastre a chave de uma IA (Gemini, ChatGPT, Claude, Groq…) em <strong>Configurações › Inteligência Artificial</strong> — o agente usa essa mesma chave.
        </div>
      )}

      <div className="ia-legal">
        ⚖️ A IA sempre se apresenta como assistente virtual e respeita pedidos de “não ligue mais” (o lead é bloqueado automaticamente). As ligações só acontecem dentro do horário
        definido na campanha. Use apenas contatos para os quais você tem base legal e confirme com seu assessor as regras de telemarketing vigentes.
      </div>

      <div className="ia-tabs">
        <button className={tab === 'campanhas' ? 'active' : ''} onClick={() => setTab('campanhas')}>📞 Campanhas</button>
        <button className={tab === 'agentes' ? 'active' : ''} onClick={() => setTab('agentes')}>🤖 Agentes (configuração)</button>
        <button className={tab === 'testar' ? 'active' : ''} onClick={() => setTab('testar')}>🧪 Testar</button>
      </div>

      {/* ---------------------------------------------------------- AGENTES */}
      {tab === 'agentes' && options && (
        <>
          <div className="ia-row ia-row-between">
            <p className="ia-muted">Cada agente é um “robô” treinado para um mercado: glossário técnico, catálogo, perguntas de qualificação e regra para chamar o vendedor.</p>
            <button className="ia-btn ia-btn-primary" onClick={() => setEditor({ agentId: null })}>+ Novo agente</button>
          </div>
          {agents.length === 0 ? (
            <div className="ia-empty">Nenhum agente ainda. Clique em “Novo agente” e comece com o modelo <strong>Estúdios de piercing</strong>.</div>
          ) : (
            <div className="ia-list-cards">
              {agents.map((agent) => (
                <div className="ia-card" key={agent.id}>
                  <div className="ia-row ia-row-between">
                    <div>
                      <h3>{agent.name}</h3>
                      <p className="ia-muted">
                        {agent.agentName} · {agent.companyName} · voz {agent.voice.replace('Polly.', '').replace('-Neural', '')} ·{' '}
                        {agent.handoffMode === 'transfer' ? 'transfere a ligação' : 'envia ao vendedor no WhatsApp'}
                      </p>
                      {agent.catalogUrl && (
                        <p className="ia-muted">
                          🌐 {agent.catalogUrl}
                          {agent.catalogFetchedAt ? ` · lido em ${new Date(agent.catalogFetchedAt).toLocaleDateString('pt-BR')}` : ' · ainda não lido'}
                        </p>
                      )}
                    </div>
                    <div className="ia-row">
                      <button className="ia-btn ia-btn-light" onClick={() => setEditor({ agentId: agent.id })}>Editar</button>
                      <button className="ia-btn ia-btn-danger" onClick={() => removeAgent(agent)}>Excluir</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- CAMPANHAS */}
      {tab === 'campanhas' && (
        <>
          <div className="ia-row ia-row-between">
            <p className="ia-muted">Cada campanha liga para um público usando um agente. Antes de começar, faça um teste na aba “Testar”.</p>
            <button className="ia-btn ia-btn-primary" onClick={openCampaignModal}>+ Nova campanha</button>
          </div>

          {campaigns.length === 0 ? (
            <div className="ia-empty">Nenhuma campanha ainda.</div>
          ) : (
            <div className="ia-list-cards">
              {campaigns.map((c) => (
                <div className="ia-card" key={c.id}>
                  <div className="ia-row ia-row-between">
                    <div>
                      <h3>{c.name}</h3>
                      <span className={`ia-status ia-status-${c.status}`}>{STATUS_LABEL[c.status] || c.status}</span>
                      <span className="ia-muted"> Agente: {c.agent?.name} · {c.windowStart}–{c.windowEnd}{c.weekdaysOnly ? ' (seg a sex)' : ''}</span>
                      {c.runningNote && c.status !== 'concluido' && <div className="ia-note">{c.runningNote}</div>}
                    </div>
                    <div className="ia-row">
                      {(c.status === 'rascunho' || c.status === 'pausado') && (
                        <button className="ia-btn ia-btn-primary" onClick={() => startCampaign(c.id)}>{c.status === 'pausado' ? '▶ Retomar' : '▶ Iniciar'}</button>
                      )}
                      {c.status === 'discando' && <button className="ia-btn ia-btn-light" onClick={() => pauseCampaign(c.id)}>⏸ Pausar</button>}
                      <button className="ia-btn ia-btn-light" onClick={() => toggleResults(c.id)}>{expandedId === c.id ? 'Ocultar' : 'Ver resultados'}</button>
                      <button className="ia-btn ia-btn-danger" onClick={() => removeCampaign(c.id)}>Excluir</button>
                    </div>
                  </div>

                  <div className="ia-stats">
                    <div><strong>{c.totalLeads}</strong><span>Leads</span></div>
                    <div><strong>{c.calledCount}</strong><span>Ligações</span></div>
                    <div><strong>{c.answeredCount}</strong><span>Atenderam</span></div>
                    <div><strong className="ia-hot">{c.hotCount}</strong><span>🔥 Quentes</span></div>
                    <div><strong>{c.handoffCount}</strong><span>Passados ao vendedor</span></div>
                    <div><strong>{c.warmCount}</strong><span>Mornos</span></div>
                    <div><strong>{c.callbackCount}</strong><span>Retornos</span></div>
                    <div><strong>{c.notInterestedCount}</strong><span>Sem interesse</span></div>
                    <div><strong>{c.noAnswerCount}</strong><span>Não atenderam</span></div>
                  </div>

                  {c.totalLeads > 0 && (
                    <div className="ia-progress"><div style={{ width: `${Math.min(100, Math.round((c.calledCount / c.totalLeads) * 100))}%` }} /></div>
                  )}

                  {expandedId === c.id && (
                    <div className="ia-table-wrap">
                      <table className="ia-table">
                        <thead><tr><th>Lead</th><th>Telefone</th><th>Resultado</th><th>Passagem</th><th>Duração</th><th /></tr></thead>
                        <tbody>
                          {(callsByCampaign[c.id] || []).map((call) => (
                            <tr key={call.id}>
                              <td>{call.lead?.name}</td>
                              <td>{call.toNumber}</td>
                              <td>{resultBadge(call)}</td>
                              <td>{call.aiSession?.handoffStatus ? HANDOFF_LABEL[call.aiSession.handoffStatus] || call.aiSession.handoffStatus : '—'}</td>
                              <td>{call.durationSeconds != null ? `${call.durationSeconds}s` : '—'}</td>
                              <td>
                                {call.aiSession && call.aiSession.turnCount > 0 && (
                                  <button className="ia-btn ia-btn-light" onClick={() => setTranscriptId(call.aiSession.id)}>Ver conversa</button>
                                )}
                              </td>
                            </tr>
                          ))}
                          {(callsByCampaign[c.id] || []).length === 0 && <tr><td colSpan="6">Nenhuma ligação feita ainda.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- TESTAR */}
      {tab === 'testar' && <AiAgentSimulator agents={agents} />}

      {/* ---------------------------------------------------------- MODAIS */}
      {editor && options && (
        <AiAgentEditor
          agentId={editor.agentId}
          options={options}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            loadAgents();
          }}
        />
      )}

      {transcriptId && <AiTranscriptModal sessionId={transcriptId} onClose={() => setTranscriptId(null)} />}

      {showCampaignModal && (
        <div className="ia-backdrop" onClick={() => setShowCampaignModal(false)}>
          <div className="ia-modal ia-modal-narrow" onClick={(e) => e.stopPropagation()}>
            <div className="ia-modal-head">
              <h2>Nova campanha do Agente IA</h2>
              <button type="button" className="ia-x" onClick={() => setShowCampaignModal(false)}>✕</button>
            </div>
            <form onSubmit={createCampaign}>
              <label>Nome da campanha</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />

              <label>Agente de IA</label>
              <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} required>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>

              <h4>Quem vai receber as ligações</h4>
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
                  <option value="perdido">Perdido</option>
                </select>
              )}
              <div className="ia-row" style={{ marginTop: 8 }}>
                <button type="button" className="ia-btn ia-btn-light" onClick={previewAudience}>Ver quantos leads</button>
                {audienceCount !== null && <span className="ia-note">{audienceCount} lead(s) serão ligados</span>}
              </div>

              <h4>Horário permitido para ligar (Brasília)</h4>
              <div className="ia-grid">
                <div><label>Das</label><input type="time" value={form.windowStart} onChange={(e) => setForm({ ...form, windowStart: e.target.value })} required /></div>
                <div><label>Até</label><input type="time" value={form.windowEnd} onChange={(e) => setForm({ ...form, windowEnd: e.target.value })} required /></div>
              </div>
              <label className="ia-check"><input type="checkbox" checked={form.weekdaysOnly} onChange={(e) => setForm({ ...form, weekdaysOnly: e.target.checked })} /> Ligar somente de segunda a sexta</label>
              <small className="ia-muted">Fora desse horário a campanha pausa sozinha. No dia seguinte, clique em “Retomar”: ela continua do próximo contato, sem repetir quem já foi ligado.</small>

              <h4>Ritmo</h4>
              <label>Número de saída</label>
              <select value={form.callerNumberId} onChange={(e) => setForm({ ...form, callerNumberId: e.target.value })}>
                <option value="">Alternar entre os números ativos</option>
                {callerNumbers.map((n) => <option key={n.id} value={n.id}>{n.label} — {n.phoneNumber}</option>)}
              </select>
              <div className="ia-grid">
                <div><label>Ligações ao mesmo tempo (1 a 3)</label><input type="number" min="1" max="3" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} /></div>
                <div><label>Intervalo mín. (s)</label><input type="number" min="0" value={form.minDelaySeconds} onChange={(e) => setForm({ ...form, minDelaySeconds: e.target.value })} /></div>
                <div><label>Intervalo máx. (s)</label><input type="number" min="0" value={form.maxDelaySeconds} onChange={(e) => setForm({ ...form, maxDelaySeconds: e.target.value })} /></div>
              </div>

              <div className="ia-modal-actions">
                <button type="button" className="ia-btn ia-btn-light" onClick={() => setShowCampaignModal(false)}>Cancelar</button>
                <button type="submit" className="ia-btn ia-btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Criar campanha'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
