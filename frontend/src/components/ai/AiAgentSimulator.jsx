// frontend/src/components/ai/AiAgentSimulator.jsx
//
// Teste do agente SEM ligar: você escreve o que o cliente diria e vê a IA
// responder (usa o mesmo cérebro da ligação). E ligação de teste para o seu celular.
import { useEffect, useRef, useState, useCallback } from 'react';
import api from '../../services/api';
import { OUTCOME_LABEL, HANDOFF_LABEL } from './AiTranscriptModal';

export default function AiAgentSimulator({ agents }) {
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  const [transcript, setTranscript] = useState([]);
  const [collected, setCollected] = useState({});
  const [turnCount, setTurnCount] = useState(0);
  const [state, setState] = useState({ outcome: null, summary: null, action: 'continue', callbackAt: null });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [calling, setCalling] = useState(false);
  const [callMessage, setCallMessage] = useState('');
  const [recentTests, setRecentTests] = useState([]);
  const endRef = useRef(null);

  const reset = useCallback(async (id) => {
    setTranscript([]);
    setCollected({});
    setTurnCount(0);
    setState({ outcome: null, summary: null, action: 'continue', callbackAt: null });
    setError('');
    if (!id) return;
    try {
      const { data } = await api.get(`/ai-calls/agents/${id}/simulate/opening`);
      setTranscript([{ role: 'agent', text: data.opening }]);
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível iniciar o teste.');
    }
  }, []);

  const loadRecentTests = useCallback(async () => {
    try {
      const { data } = await api.get('/ai-calls/sessions/tests/recent');
      setRecentTests(data.sessions);
    } catch {
      // opcional
    }
  }, []);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);

  useEffect(() => {
    reset(agentId);
  }, [agentId, reset]);

  useEffect(() => {
    loadRecentTests();
  }, [loadRecentTests]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  async function send(e) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending || state.action !== 'continue') return;
    setSending(true);
    setError('');
    try {
      const { data } = await api.post(`/ai-calls/agents/${agentId}/simulate`, { transcript, message, collected, turnCount });
      const reply = data.reply;
      setTranscript((prev) => [...prev, { role: 'lead', text: message }, { role: 'agent', text: reply.say, raw: reply.raw }]);
      setCollected((prev) => ({ ...prev, ...reply.collected }));
      setTurnCount((n) => n + 1);
      setState({
        outcome: reply.outcome || state.outcome,
        summary: reply.summary || state.summary,
        action: reply.action,
        callbackAt: reply.callbackAt || state.callbackAt
      });
      setInput('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Erro ao falar com a IA.');
    } finally {
      setSending(false);
    }
  }

  async function testCall() {
    setCalling(true);
    setCallMessage('');
    try {
      await api.post(`/ai-calls/agents/${agentId}/test-call`, { phone });
      setCallMessage('📞 Ligando para o seu celular… atenda e converse com a IA. Depois clique em “Atualizar” para ver o resultado.');
    } catch (err) {
      setCallMessage(`❌ ${err.response?.data?.error || 'Não foi possível ligar.'}`);
    } finally {
      setCalling(false);
    }
  }

  if (agents.length === 0) {
    return <div className="ia-empty">Crie um agente primeiro (aba “Agentes”) para poder testar.</div>;
  }

  return (
    <div className="ia-sim">
      <div className="ia-sim-main">
        <div className="ia-card">
          <div className="ia-row ia-row-between">
            <div>
              <h3>🧪 Conversa de teste (por texto)</h3>
              <p className="ia-muted">Escreva como o cliente responderia e veja o que a IA diria. Não gera ligação nem custo de telefonia (usa só a sua chave de IA).</p>
            </div>
            <div className="ia-row">
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button type="button" className="ia-btn ia-btn-light" onClick={() => reset(agentId)}>↺ Recomeçar</button>
            </div>
          </div>

          <div className="ia-chat ia-chat-tall">
            {transcript.map((turn, index) => (
              <div key={index} className={`ia-bubble ${turn.role === 'agent' ? 'ia-bubble-agent' : 'ia-bubble-lead'}`}>
                <small>{turn.role === 'agent' ? '🤖 IA' : '👤 Você (cliente)'}</small>
                {turn.text}
              </div>
            ))}
            {sending && <div className="ia-bubble ia-bubble-agent"><small>🤖 IA</small>digitando…</div>}
            <div ref={endRef} />
          </div>

          {state.action === 'handoff' && <div className="ia-alert ia-alert-hot">🔥 Neste ponto a IA chamaria o vendedor (transferindo a ligação ou enviando o contato no WhatsApp, conforme configurado).</div>}
          {state.action === 'end' && <div className="ia-alert">📴 A IA encerraria a ligação aqui. Clique em “Recomeçar” para testar de novo.</div>}
          {error && <p className="ia-error">{error}</p>}

          <form className="ia-row" onSubmit={send}>
            <input
              className="ia-grow"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="O que o cliente diz… (ex.: “quanto custa o labret de titânio?”)"
              disabled={sending || state.action !== 'continue'}
            />
            <button type="submit" className="ia-btn ia-btn-primary" disabled={sending || !input.trim() || state.action !== 'continue'}>Enviar</button>
          </form>
        </div>
      </div>

      <div className="ia-sim-side">
        <div className="ia-card">
          <h3>📊 O que a IA entendeu</h3>
          <p><strong>Avaliação:</strong> {state.outcome ? OUTCOME_LABEL[state.outcome] : '—'}</p>
          <p><strong>Resumo:</strong> {state.summary || '—'}</p>
          {state.callbackAt && <p><strong>Retorno combinado:</strong> {new Date(state.callbackAt).toLocaleString('pt-BR')}</p>}
          <strong>Informações coletadas</strong>
          {Object.keys(collected).length === 0 ? (
            <p className="ia-muted">Nada ainda.</p>
          ) : (
            <ul className="ia-list">
              {Object.entries(collected).map(([k, v]) => <li key={k}><span>{k.replace(/_/g, ' ')}:</span> {String(v)}</li>)}
            </ul>
          )}
        </div>

        <div className="ia-card">
          <h3>📞 Ligar para o meu celular</h3>
          <p className="ia-muted">Teste real: o agente liga para você com a voz e o reconhecimento de fala da Twilio. Precisa de Twilio configurada e de um número de saída ativo.</p>
          <div className="ia-row">
            <input className="ia-grow" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 99999-8888" />
            <button type="button" className="ia-btn ia-btn-primary" disabled={calling || !phone.trim()} onClick={testCall}>
              {calling ? 'Ligando…' : 'Ligar'}
            </button>
          </div>
          {callMessage && <p className="ia-note">{callMessage}</p>}

          <div className="ia-row ia-row-between" style={{ marginTop: 12 }}>
            <strong>Últimos testes</strong>
            <button type="button" className="ia-btn ia-btn-light" onClick={loadRecentTests}>↻ Atualizar</button>
          </div>
          {recentTests.length === 0 && <p className="ia-muted">Nenhuma ligação de teste ainda.</p>}
          <ul className="ia-list">
            {recentTests.map((t) => (
              <li key={t.id}>
                {new Date(t.createdAt).toLocaleString('pt-BR')} — {t.outcome ? OUTCOME_LABEL[t.outcome] || t.outcome : 'em andamento'}
                {t.handoffStatus ? ` · ${HANDOFF_LABEL[t.handoffStatus] || t.handoffStatus}` : ''}
                {t.summary ? <div className="ia-muted">{t.summary}</div> : null}
                {['quente', 'morno', 'retorno_agendado'].includes(t.outcome) && (
                  <div className="ia-muted">
                    {t.crmColumn ? `📇 No CRM, coluna "${t.crmColumn}"` : '📇 Ainda não apareceu no CRM (confira em instantes ou veja o relatório em Conversas)'}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
