// frontend/src/components/ai/AiTranscriptModal.jsx
import { useEffect, useState } from 'react';
import api from '../../services/api';

export const OUTCOME_LABEL = {
  quente: '🔥 Lead quente',
  morno: '🌤️ Lead morno',
  frio: '❄️ Lead frio',
  nao_interessado: 'Sem interesse',
  optout: '🚫 Pediu para não ligar',
  retorno_agendado: '📅 Retorno agendado',
  numero_errado: 'Número errado',
  caixa_postal: '📭 Caixa postal',
  sem_resposta: 'Não respondeu',
  sem_conclusao: 'Sem conclusão'
};

export const HANDOFF_LABEL = {
  transferindo: '📞 Transferindo para o vendedor…',
  conectada: '📞 Transferida — o vendedor atendeu',
  vendedor_indisponivel: '📵 O vendedor não atendeu (aviso enviado, retorno no CRM)',
  whatsapp_enviado: '💬 Contato enviado ao vendedor no WhatsApp',
  whatsapp_pendente: '⏳ Passagem registrada (WhatsApp do vendedor não estava conectado)'
};

export default function AiTranscriptModal({ sessionId, onClose }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/ai-calls/sessions/${sessionId}`)
      .then((res) => setSession(res.data.session))
      .catch((err) => setError(err.response?.data?.error || 'Não foi possível carregar a conversa.'));
  }, [sessionId]);

  return (
    <div className="ia-backdrop" onClick={onClose}>
      <div className="ia-modal ia-modal-narrow" onClick={(e) => e.stopPropagation()}>
        <div className="ia-modal-head">
          <h2>💬 Conversa da ligação</h2>
          <button type="button" className="ia-x" onClick={onClose}>✕</button>
        </div>

        {error && <p className="ia-error">{error}</p>}
        {!session && !error && <p className="ia-muted">Carregando…</p>}

        {session && (
          <>
            <div className="ia-meta">
              {session.outcome && <span className={`ia-badge ia-badge-${session.outcome}`}>{OUTCOME_LABEL[session.outcome] || session.outcome}</span>}
              {session.handoffStatus && <span className="ia-badge ia-badge-info">{HANDOFF_LABEL[session.handoffStatus] || session.handoffStatus}</span>}
              {session.callbackAt && <span className="ia-badge ia-badge-info">📅 Retorno: {new Date(session.callbackAt).toLocaleString('pt-BR')}</span>}
            </div>

            {session.summary && <p className="ia-summary"><strong>Resumo da IA:</strong> {session.summary}</p>}

            {session.collected && Object.keys(session.collected).length > 0 && (
              <div className="ia-collected">
                <strong>Informações coletadas</strong>
                <ul>
                  {Object.entries(session.collected).map(([key, value]) => (
                    <li key={key}><span>{key.replace(/_/g, ' ')}:</span> {String(value)}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="ia-chat">
              {(session.transcript || []).map((turn, index) => (
                <div key={index} className={`ia-bubble ${turn.role === 'agent' ? 'ia-bubble-agent' : 'ia-bubble-lead'}`}>
                  <small>{turn.role === 'agent' ? '🤖 IA' : '👤 Cliente'}</small>
                  {turn.text}
                </div>
              ))}
              {(!session.transcript || session.transcript.length === 0) && <p className="ia-muted">Sem conversa registrada.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
