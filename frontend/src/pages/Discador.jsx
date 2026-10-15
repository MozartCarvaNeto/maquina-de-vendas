// frontend/src/pages/Discador.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import './Discador.css';

export default function Discador() {
  const [queue, setQueue] = useState({
    pendingCount: 0,
    pending: [],
    ongoingCall: null,
    availableAgents: 0,
    totalAgents: 0,
    totalCallerNumbers: 0,
    ongoingCalls: [],
    autoDialRunning: false,
    lastError: null
  });
  const [autoDialEnabled, setAutoDialEnabled] = useState(false);
  const [recordCallsEnabled, setRecordCallsEnabled] = useState(false);
  const [team, setTeam] = useState({ agents: [], myAgentId: null });
  const [lists, setLists] = useState([]);
  const [selectedListId, setSelectedListId] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [listMessage, setListMessage] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  const loadQueue = useCallback(async () => {
    const { data } = await api.get('/calls/queue');
    setQueue(data);
  }, []);

  const loadTeam = useCallback(async () => {
    try {
      const { data } = await api.get('/calls/team');
      setTeam({ agents: data.agents || [], myAgentId: data.myAgentId || null });
    } catch (error) {
      /* mantém o último estado */
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const { data } = await api.get('/calls/settings');
    setAutoDialEnabled(data.settings?.autoDialEnabled || false);
    setRecordCallsEnabled(data.settings?.recordCallsEnabled || false);
    setSelectedListId(data.settings?.autoDialListId || '');
  }, []);

  const loadLists = useCallback(async () => {
    try {
      const { data } = await api.get('/call-queue/lists');
      setLists(data.lists || []);
    } catch (error) {
      setLists([]);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const { data } = await api.get('/calls?pageSize=15');
    setHistory(data.calls);
  }, []);

  useEffect(() => {
    loadQueue();
    loadSettings();
    loadHistory();
    loadLists();
    loadTeam();
  }, [loadQueue, loadSettings, loadHistory, loadLists, loadTeam]);

  // Com o discador automático rodando, a tela se atualiza sozinha (fila, equipe e ligações em andamento).
  useEffect(() => {
    const timer = setInterval(() => {
      loadQueue();
      loadTeam();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadQueue, loadTeam]);

  useEffect(() => {
    if (!socket) return undefined;

    const refresh = () => {
      loadQueue();
      loadHistory();
      loadTeam();
    };

    socket.on('call:answered', refresh);
    socket.on('call:ended', refresh);
    socket.on('call:recording_ready', refresh);
    socket.on('dialer:team_changed', refresh);
    socket.on('dialer:agent_auto_paused', refresh);
    return () => {
      socket.off('call:answered', refresh);
      socket.off('call:ended', refresh);
      socket.off('call:recording_ready', refresh);
      socket.off('dialer:team_changed', refresh);
      socket.off('dialer:agent_auto_paused', refresh);
    };
  }, [socket, loadQueue, loadHistory, loadTeam]);

  async function persistSettings(next) {
    try {
      await api.post('/calls/settings', next);
      loadQueue();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao salvar configuração');
      loadSettings();
    }
  }

  function handleToggleAutoDial(e) {
    const value = e.target.checked;
    setAutoDialEnabled(value);
    persistSettings({ autoDialEnabled: value, recordCallsEnabled, autoDialListId: selectedListId });
  }

  function handleToggleRecording(e) {
    const value = e.target.checked;
    setRecordCallsEnabled(value);
    persistSettings({ autoDialEnabled, recordCallsEnabled: value, autoDialListId: selectedListId });
  }

  function handleSelectList(e) {
    const value = e.target.value;
    setSelectedListId(value);
    setListMessage('');
    persistSettings({ autoDialEnabled, recordCallsEnabled, autoDialListId: value });
  }

  async function handleLoadList(replace) {
    if (!selectedListId) {
      setListMessage('Escolha uma lista primeiro.');
      return;
    }
    setLoadingList(true);
    setListMessage('');
    try {
      const { data } = await api.post('/calls/queue/load-list', { listId: selectedListId, replace });
      const s = data.skipped || {};
      const parts = [];
      if (s.semTelefone) parts.push(`${s.semTelefone} sem telefone`);
      if (s.optOut) parts.push(`${s.optOut} pediram para não receber`);
      if (s.perdido) parts.push(`${s.perdido} perdidos`);
      if (s.jaNaFila) parts.push(`${s.jaNaFila} já estavam na fila`);
      if (s.ligadoRecentemente) parts.push(`${s.ligadoRecentemente} ligados nas últimas 12 h`);
      setListMessage(`✅ ${data.enqueued} contato(s) da lista "${data.list.name}" entraram na fila.${parts.length ? ` Ignorados: ${parts.join(', ')}.` : ''}`);
      loadQueue();
    } catch (error) {
      setListMessage(error.response?.data?.error || 'Não foi possível carregar a lista.');
    } finally {
      setLoadingList(false);
    }
  }

  async function handleStartNext() {
    setLoading(true);
    try {
      const { data } = await api.post('/calls/queue/next');
      if (!data.call) {
        alert('A fila de discagem está vazia.');
      }
      loadQueue();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao iniciar ligação');
    } finally {
      setLoading(false);
    }
  }

  async function handleHangup(callId) {
    if (!callId) return;
    try {
      await api.post(`/calls/${callId}/hangup`);
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível encerrar a ligação');
    }
    loadQueue();
    loadTeam();
  }

  async function handleClearQueue() {
    if (!window.confirm('Esvaziar a fila de discagem? Quem já está em ligação não é afetado.')) return;
    try {
      const { data } = await api.post('/calls/queue/clear');
      setListMessage(`🗑️ ${data.removed} contato(s) removidos da fila.`);
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível limpar a fila');
    }
    loadQueue();
  }

  async function handleStopDialer() {
    if (!window.confirm('Parar o discador? O modo automático é desligado e as ligações em andamento são encerradas.')) return;
    try {
      await api.post('/calls/dialer/stop');
      setAutoDialEnabled(false);
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível parar o discador');
    }
    loadQueue();
    loadTeam();
  }

  async function handleTogglePause(agent) {
    try {
      await api.post(`/calls/agents/${agent.id}/pause`, { paused: !agent.isPaused });
      loadTeam();
      loadQueue();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao alterar a pausa');
    }
  }

  async function handlePlayRecording(callId) {
    setPlayingId(callId);
    try {
      const response = await api.get(`/calls/${callId}/recording`, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const audio = new Audio(url);
      audio.play();
      audio.onended = () => setPlayingId(null);
    } catch (error) {
      alert('Gravação ainda não disponível ou não encontrada.');
      setPlayingId(null);
    }
  }

  const ongoingLeadHasNoPhone = queue.ongoingCall && !queue.ongoingCall.lead?.phone;
  const myAgent = team.agents.find((a) => a.isMine);
  const STATE_LABEL = { livre: '🟢 Livre', em_ligacao: '📞 Em ligação', pausado: '⏸️ Pausado', inativo: '⚪ Inativo' };

  return (
    <div className="discador-page">
      <header>
        <h1>Discador Automático</h1>
        <p>Ligue automaticamente para os leads qualificados da sua fila.</p>
      </header>

      {(queue.totalAgents === 0 || queue.totalCallerNumbers === 0) && (
        <div className="discador-warning">
          ⚠️ Antes de discar, cadastre pelo menos um número e um vendedor em{' '}
          <a href="/linhas">Linhas</a>.
        </div>
      )}

      {ongoingLeadHasNoPhone && (
        <div className="discador-warning discador-warning-danger">
          ⚠️ Este item da fila não tem telefone válido — não deveria ter sido enfileirado. Verifique o cadastro
          do lead em Contatos.
        </div>
      )}

      <div className="discador-grid">
        <div className="card">
          <h3>Configuração</h3>
          <label className="checkbox-label">
            <input type="checkbox" checked={autoDialEnabled} onChange={handleToggleAutoDial} />
            Modo automático (discar sozinho, sem clicar)
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={recordCallsEnabled} onChange={handleToggleRecording} />
            🎙️ Gravar ligações automaticamente
          </label>

          <label htmlFor="discador-lista"><strong>Lista para discagem automática</strong></label>
          <select id="discador-lista" value={selectedListId} onChange={handleSelectList}>
            <option value="">— Escolha uma lista de contatos —</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.totalContacts} contatos)</option>
            ))}
          </select>
          {lists.length === 0 && <small className="secondary-text">Nenhuma lista criada ainda. Crie em Contatos &gt; Listas.</small>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
            <button type="button" className="btn-primary" onClick={() => handleLoadList(true)} disabled={loadingList || !selectedListId}>
              {loadingList ? 'Carregando…' : '📥 Carregar lista na fila'}
            </button>
            <button type="button" className="btn-outline" onClick={() => handleLoadList(false)} disabled={loadingList || !selectedListId}>
              ➕ Adicionar sem limpar a fila
            </button>
          </div>
          {listMessage && <p className="secondary-text">{listMessage}</p>}
          <small className="secondary-text">Com o modo automático ligado, depois de “Iniciar próxima ligação” o discador segue sozinho pela fila carregada.</small>

          <div className="discador-team-status">
            <span>👤 Vendedores disponíveis agora</span>
            <strong>{queue.availableAgents} / {queue.totalAgents}</strong>
          </div>
          <div className="discador-team-status">
            <span>📞 Números de discagem cadastrados</span>
            <strong>{queue.totalCallerNumbers}</strong>
          </div>
        </div>

        <div className="card">
          <h3>Equipe de vendedores</h3>
          {myAgent && (
            <div className={`discador-warning ${myAgent.isPaused ? 'discador-warning-danger' : ''}`} style={{ marginBottom: 8 }}>
              {myAgent.isPaused
                ? '⏸️ Você está em pausa: o discador não passa ligações para você. Os outros vendedores continuam.'
                : '🟢 Você está disponível para receber ligações.'}
              {myAgent.state !== 'em_ligacao' && (
                <button type="button" className={myAgent.isPaused ? 'btn-primary' : 'btn-outline'} style={{ marginLeft: 8 }} onClick={() => handleTogglePause(myAgent)}>
                  {myAgent.isPaused ? '▶ Voltar ao atendimento' : '⏸️ Pausar meu atendimento'}
                </button>
              )}
            </div>
          )}
          <ul className="queue-preview-list">
            {team.agents.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{a.name}{a.isMine ? ' (você)' : ''}</strong>{' '}
                  <span className="secondary-text">{STATE_LABEL[a.state] || a.state}{a.currentLead ? ` · ${a.currentLead}` : ''}</span>
                </span>
                {a.canControl && a.state !== 'inativo' && (
                  <button type="button" className="btn-outline" disabled={a.state === 'em_ligacao'} onClick={() => handleTogglePause(a)}>
                    {a.isPaused ? '▶ Retomar' : '⏸️ Pausar'}
                  </button>
                )}
              </li>
            ))}
            {team.agents.length === 0 && <p className="empty-state">Nenhum vendedor cadastrado. Cadastre em <a href="/linhas">Linhas</a>.</p>}
          </ul>
          <small className="secondary-text">
            O discador chama vários leads ao mesmo tempo, um para cada vendedor livre, e passa cada atendimento ao próximo da fila de vendedores.
            Com um só vendedor, ele só volta a discar quando a linha estiver livre. A pausa vale só para quem pausou.
          </small>
        </div>

        <div className="card">
          <h3>Fila de Discagem</h3>
          <p className="queue-count">{queue.pendingCount} leads aguardando</p>

          {queue.autoDialRunning && (
            <p className="secondary-text">
              🤖 Discador automático ligado: o sistema liga sozinho enquanto houver vendedor livre.
              {queue.pendingCount === 0 && ' A fila está vazia — carregue uma lista.'}
            </p>
          )}
          {queue.blockedReason && (
            <div className="discador-warning">⏳ Não está discando agora: {queue.blockedReason}</div>
          )}
          {queue.lastError && (
            <div className="discador-warning discador-warning-danger">⚠️ {queue.lastError.message}</div>
          )}

          {(queue.ongoingCalls || []).map((call) => (
            <div className="ongoing-call" key={call.id}>
              <strong>{call.lead?.name} {call.status === 'atendida' ? '— em conversa' : '— chamando…'}</strong>
              <span>Vendedor: {call.agent?.name || '-'} · {call.status}</span>
              <button className="btn-danger" onClick={() => handleHangup(call.id)}>Encerrar ligação</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn-primary" onClick={handleStartNext} disabled={loading}>
              {loading ? 'Discando...' : '📞 Iniciar próxima ligação (manual)'}
            </button>
            <button className="btn-outline" onClick={handleClearQueue} disabled={queue.pendingCount === 0}>🗑️ Limpar fila</button>
            <button className="btn-danger" onClick={handleStopDialer}>⏹️ Parar discador</button>
          </div>
        </div>

        <div className="card queue-preview-card">
          <h3>Próximos na fila</h3>
          <ul className="queue-preview-list">
            {queue.pending.slice(0, 8).map((item) => (
              <li key={item.id}>
                <span>{item.lead.name}</span>
                <span className="secondary-text">{item.lead.phone}</span>
              </li>
            ))}
            {queue.pending.length === 0 && <p className="empty-state">Fila vazia</p>}
          </ul>
        </div>

        <div className="card history-card">
          <h3>Histórico Recente</h3>
          <table>
            <thead>
              <tr><th>Lead</th><th>Vendedor</th><th>Status</th><th>Duração</th><th>Gravação</th></tr>
            </thead>
            <tbody>
              {history.map((call) => (
                <tr key={call.id}>
                  <td>{call.lead.name}</td>
                  <td>{call.agent?.name || '-'}</td>
                  <td>{call.status}</td>
                  <td>{call.durationSeconds ? `${call.durationSeconds}s` : '-'}</td>
                  <td>
                    {call.recordingUrl ? (
                      <button className="btn-outline" onClick={() => handlePlayRecording(call.id)} disabled={playingId === call.id}>
                        {playingId === call.id ? '▶ Tocando...' : '▶ Ouvir'}
                      </button>
                    ) : (
                      <span className="secondary-text">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={5} className="empty-state">Nenhuma ligação registrada ainda</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}