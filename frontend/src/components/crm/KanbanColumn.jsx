// frontend/src/components/crm/KanbanColumn.jsx
import { useState } from 'react';
import KanbanCard from './KanbanCard';
import { getFollowUpState, isLostColumn } from './followUpUtils';
import './FollowUps.css';

export default function KanbanColumn({ column, onDropCard, onOpenCard }) {
  const [isDragOver, setIsDragOver] = useState(false);

  function handleDragOver(e) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    const cardId = e.dataTransfer.getData('cardId');
    if (cardId) {
      onDropCard(cardId, column.id, column.cards.length);
    }
  }

  const totalValue = column.cards.reduce((sum, card) => sum + (card.value || 0), 0);
  const isLost = isLostColumn(column);
  const overdueCount = column.cards.filter((card) => getFollowUpState(card.followUpAt) === 'overdue').length;

  return (
    <div
      className={`kanban-column ${isDragOver ? 'drag-over' : ''} ${isLost ? 'is-lost' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ borderTopColor: column.color }}
    >
      <div className="kanban-column-header">
        <h3>{column.name}</h3>
        <div className="kanban-column-header-right">
          {overdueCount > 0 && (
            <span className="kanban-column-alert" title="Retornos atrasados">⚠️ {overdueCount}</span>
          )}
          <span className="kanban-column-count">{column.cards.length}</span>
        </div>
      </div>
      {isLost && <p className="kanban-column-sub">Clientes que podem voltar no futuro com outras promoções.</p>}
      {totalValue > 0 && (
        <div className="kanban-column-value">
          R$ {totalValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </div>
      )}

      <div className="kanban-column-cards">
        {column.cards.length === 0 && <p className="kanban-empty">Nenhum card aqui</p>}
        {column.cards.map((card) => (
          <KanbanCard key={card.id} card={card} isLost={isLost} onOpen={() => onOpenCard(card)} />
        ))}
      </div>
    </div>
  );
}
