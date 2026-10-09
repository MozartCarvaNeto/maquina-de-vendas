// frontend/src/pages/CRM.jsx
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import KanbanColumn from '../components/crm/KanbanColumn';
import CardDetailModal from '../components/crm/CardDetailModal';
import AddCardModal from '../components/crm/AddCardModal';
import { refreshFollowUps } from '../hooks/useFollowUps';
import './CRM.css';

export default function CRM() {
  // Vindo do aviso da tela inicial: /crm?board=ID&card=ID abre direto o card do cliente.
  const [searchParams, setSearchParams] = useSearchParams();
  const [boards, setBoards] = useState([]);
  const [activeBoardId, setActiveBoardId] = useState(searchParams.get('board'));
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedCard, setSelectedCard] = useState(null);
  const [showAddCardModal, setShowAddCardModal] = useState(false);

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  const loadBoards = useCallback(async () => {
    const { data } = await api.get('/crm/boards');
    setBoards(data.boards);
    if (data.boards.length > 0 && !activeBoardId) {
      setActiveBoardId(data.boards[0].id);
    }
  }, [activeBoardId]);

  const loadBoard = useCallback(async (boardId) => {
    if (!boardId) return;
    setLoading(true);
    const { data } = await api.get(`/crm/boards/${boardId}`);
    setBoard(data.board);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    loadBoard(activeBoardId);
  }, [activeBoardId, loadBoard]);

  useEffect(() => {
    const cardId = searchParams.get('card');
    if (!cardId || !board) return;
    const found = board.columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
    if (found) setSelectedCard(found);
    setSearchParams({}, { replace: true });
  }, [board, searchParams, setSearchParams]);

  useEffect(() => {
    if (!socket) return undefined;

    const handleCardMoved = () => {
      loadBoard(activeBoardId);
    };

    socket.on('crm:card_moved', handleCardMoved);
    return () => socket.off('crm:card_moved', handleCardMoved);
  }, [socket, activeBoardId, loadBoard]);

  async function handleDropCard(cardId, targetColumnId, targetPosition) {
    setBoard((prev) => {
      if (!prev) return prev;
      const clone = structuredClone(prev);
      let movedCard = null;

      clone.columns.forEach((col) => {
        const idx = col.cards.findIndex((c) => c.id === cardId);
        if (idx !== -1) {
          [movedCard] = col.cards.splice(idx, 1);
        }
      });

      const targetCol = clone.columns.find((c) => c.id === targetColumnId);
      if (targetCol && movedCard) {
        targetCol.cards.splice(targetPosition, 0, movedCard);
      }

      return clone;
    });

    try {
      await api.post(`/crm/cards/${cardId}/move`, { targetColumnId, targetPosition });
    } catch (error) {
      console.error('Erro ao mover card, recarregando board:', error);
      loadBoard(activeBoardId);
    }
  }

  if (loading || !board) {
    return <div className="crm-loading">Carregando funil...</div>;
  }

  // Sempre a versão mais nova do card aberto (coluna e dados de retorno agendado).
  const selectedColumn = selectedCard ? board.columns.find((c) => c.cards.some((x) => x.id === selectedCard.id)) : null;
  const selectedFresh = selectedColumn ? selectedColumn.cards.find((x) => x.id === selectedCard.id) : selectedCard;

  return (
    <div className="crm-page">
      <header className="crm-header">
        <div>
          <h1>{board.name}</h1>
          <p>Gerencie seus leads qualificados, negociações e vendas fechadas.</p>
        </div>
        <div className="crm-header-actions">
          <select
            className="crm-board-select"
            value={activeBoardId || ''}
            onChange={(e) => setActiveBoardId(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => setShowAddCardModal(true)}>
            ➕ Adicionar lead ao quadro
          </button>
        </div>
      </header>

      <div className="kanban-scroll">
        {board.columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            onDropCard={handleDropCard}
            onOpenCard={setSelectedCard}
          />
        ))}
      </div>

      {selectedCard && (
        <CardDetailModal
          key={selectedFresh.id}
          card={selectedFresh}
          column={selectedColumn}
          columns={board.columns}
          onClose={() => setSelectedCard(null)}
          onSaved={() => {
            setSelectedCard(null);
            loadBoard(activeBoardId);
            refreshFollowUps();
          }}
        />
      )}

      {showAddCardModal && (
        <AddCardModal
          columns={board.columns}
          defaultColumnId={board.columns[0]?.id}
          onClose={() => setShowAddCardModal(false)}
          onAdded={() => {
            setShowAddCardModal(false);
            loadBoard(activeBoardId);
          }}
        />
      )}
    </div>
  );
}