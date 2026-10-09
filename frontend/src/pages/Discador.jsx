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
    totalCallerNumbers: 0
  });
  const [autoDialEnabled, setAutoDialEnabled] = useState(false);
  const [recordCallsEnabled, setRecordCallsEnabled] = useState(false);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  const loadQueue = useCallback(async () => {
    const { data } = await api.get('/calls/queue');
    setQueue(data);
  }, []);

  const loadSettings = useCallback(async () => {
    const { data } = await api.get('/calls/settings');
    setAutoDialEnabled(data.settings?.autoDialEnabled || false);
    setRecordCallsEnabled(data.settings?.recordCallsEnabled || false);
  }, []);

  const loadHistory = useCallback(async () => {
    const { data } = await api.get('/calls?pageSize=15');
    setHistory(data.calls);
  }, []);

  useEffect(() => {
    loadQueue();
    loadSettings();
    loadHistory();
  }, [loadQueue, loadSettings, loadHistory]);

  useEffect(() => {
    if (!socket) return undefined;

    const refresh = () => {
      loadQueue();
      loadHistory();
    };

    socket.on('call:answered', refresh);
    socket.on('call:ended', refresh);
    socket.on('call:recording_ready', refresh);
    return () => {
      socket.off('call:answered', refresh);
      socket.off('call:ended', refresh);
      socket.off('call:recording_ready', refresh);
    };
  }, [socket, loadQueue, loadHistory]);

  async function persistSettings(next) {
    try {
      await api.post('/calls/settings', next);
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao salvar configuração');
      loadSettings();
    }
  }

  function handleToggleAutoDial(e) {
    const value = e.target.checked;
    setAutoDialEnabled(value);
    persistSettings({ autoDialEnabled: value, recordCallsEnabled });
  }

  function handleToggleRecording(e) {
    const value = e.target.checked;
    setRecordCallsEnabled(value);
    persistSettings({ autoDialEnabled, recordCallsEnabled: value });
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

  async function handleHangup() {
    if (!queue.ongoingCall) return;
    await api.post(`/calls/${queue.ongoingCall.id}/hangup`);
    loadQueue();
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
          <h3>Fila de Discagem</h3>
          <p className="queue-count">{queue.pendingCount} leads aguardando</p>

          {queue.ongoingCall ? (
            <div className="ongoing-call">
              <strong>Ligando para {queue.ongoingCall.lead.name}...</strong>
              <span>{queue.ongoingCall.status}</span>
              <button className="btn-danger" onClick={handleHangup}>Encerrar ligação</button>
            </div>
          ) : (
            <button className="btn-primary" onClick={handleStartNext} disabled={loading}>
              {loading ? 'Discando...' : '📞 Iniciar próxima ligação'}
            </button>
          )}
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