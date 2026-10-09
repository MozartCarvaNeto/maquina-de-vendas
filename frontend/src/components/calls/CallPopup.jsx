// frontend/src/components/calls/CallPopup.jsx
import { useState, useEffect } from 'react';
import { useSocket } from '../../hooks/useSocket';
import './CallPopup.css';

/**
 * Componente GLOBAL — deve ficar montado no layout principal (App.jsx),
 * fora das rotas, para que o popup apareça independentemente da tela
 * em que o vendedor estiver quando o lead atender.
 */
export default function CallPopup() {
  const [activeCall, setActiveCall] = useState(null);
  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  // IMPORTANTE: a sala do socket é por CONTA (accountId), não por login
  // individual (id). O backend sempre emite para `user:${accountId}`.
  const { socket } = useSocket(currentUser.accountId);

  useEffect(() => {
    if (!socket) return undefined;

    const handleAnswered = (data) => {
      setActiveCall(data);
      const audio = new Audio('/sounds/call-answered.mp3');
      audio.play().catch(() => null);
    };

    const handleEnded = () => setActiveCall(null);

    socket.on('call:answered', handleAnswered);
    socket.on('call:ended', handleEnded);

    return () => {
      socket.off('call:answered', handleAnswered);
      socket.off('call:ended', handleEnded);
    };
  }, [socket]);

  if (!activeCall) return null;

  return (
    <div className="call-popup">
      <div className="call-popup-header">📞 Lead atendeu!</div>
      <div className="call-popup-body">
        <strong>{activeCall.leadName}</strong>
        <span>{activeCall.leadPhone}</span>
        <p>Seu telefone vai tocar em instantes. Atenda para falar com o lead.</p>
      </div>
      <div className="call-popup-actions">
        <a href={`/crm?leadId=${activeCall.leadId}`} className="btn-outline">Ver no CRM</a>
        <button className="btn-primary" onClick={() => setActiveCall(null)}>Fechar aviso</button>
      </div>
    </div>
  );
}