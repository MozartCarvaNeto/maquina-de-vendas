// frontend/src/components/crm/KanbanCard.jsx
import { getFollowUpState, formatFollowUpLabel } from './followUpUtils';
import './FollowUps.css';

export default function KanbanCard({ card, onOpen, isLost = false }) {
  function handleDragStart(e) {
    e.dataTransfer.setData('cardId', card.id);
  }

  // Retorno agendado: vermelho se passou do horário sem retorno, amarelo se vence hoje.
  const followState = getFollowUpState(card.followUpAt);
  const stateClass = followState ? `fu-${followState}` : '';

  return (
    <div className={`kanban-card ${stateClass}`} draggable onDragStart={handleDragStart} onClick={onOpen}>
      <strong>{card.lead.name}</strong>
      <span className="kanban-card-phone">{card.lead.phone}</span>
      {card.value > 0 && (
        <span className="kanban-card-value">
          R$ {card.value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </span>
      )}

      {followState && (
        <span className={`fu-badge fu-${followState}`}>
          {followState === 'overdue' ? '⚠️ ' : '🔔 '}
          {isLost && followState !== 'overdue' ? 'Revisitar: ' : ''}
          {formatFollowUpLabel(card.followUpAt)}
        </span>
      )}
      {card.followUpNote && followState && <span className="fu-card-note">{card.followUpNote}</span>}

      {isLost && card.lostReason && <span className="fu-badge fu-lost">Motivo: {card.lostReason}</span>}
      {card.notes && <p className="kanban-card-notes">{card.notes}</p>}
    </div>
  );
}
