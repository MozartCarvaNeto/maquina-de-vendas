// frontend/src/components/crm/FollowUpPanel.jsx
//
// Aviso da tela inicial: clientes com retorno vencendo hoje e atrasados.
import { useNavigate } from 'react-router-dom';
import { useFollowUps, requestFollowUpNotifications } from '../../hooks/useFollowUps';
import { formatFollowUpLabel } from './followUpUtils';
import './FollowUps.css';

function Item({ item, onOpen }) {
  return (
    <li className={`fu-item fu-${item.state}`}>
      <div>
        <strong>
          {item.state === 'overdue' ? '⚠️ ' : item.state === 'today' ? '🔔 ' : '📅 '}
          {item.leadName}
        </strong>
        <span>
          {item.leadPhone || 'sem telefone'} · {item.columnName}
          {item.note ? ` · ${item.note}` : ''}
        </span>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span className={`fu-when fu-${item.state}`}>{formatFollowUpLabel(item.followUpAt)}</span>
        <div>
          <button type="button" className="fu-btn-small fu-btn-primary" style={{ marginTop: 4 }} onClick={() => onOpen(item)}>
            Abrir no CRM
          </button>
        </div>
      </div>
    </li>
  );
}

export default function FollowUpPanel() {
  const navigate = useNavigate();
  const { loaded, counts, due, upcoming } = useFollowUps();

  const canAskNotifications = typeof Notification !== 'undefined' && Notification.permission === 'default';

  function openInCrm(item) {
    navigate(`/crm?board=${item.boardId}&card=${item.cardId}`);
  }

  if (!loaded) return null;

  const hasDue = due.length > 0;

  return (
    <section className={`fu-panel ${counts.overdue > 0 ? 'has-overdue' : ''}`}>
      <div className="fu-panel-head">
        <h2>🔔 Retornos de clientes</h2>
        {canAskNotifications && (
          <button type="button" className="fu-btn-small fu-btn-neutral" onClick={() => requestFollowUpNotifications().then(() => window.location.reload())}>
            Ativar avisos no navegador
          </button>
        )}
      </div>

      <div className="fu-chips">
        <span className="fu-chip fu-overdue">⚠️ {counts.overdue} atrasado(s)</span>
        <span className="fu-chip fu-today">🔔 {counts.today} vence(m) hoje</span>
        <span className="fu-chip fu-scheduled">📅 {counts.upcoming} nos próximos dias</span>
      </div>

      {hasDue ? (
        <ul className="fu-list">
          {due.map((item) => <Item key={item.cardId} item={item} onOpen={openInCrm} />)}
        </ul>
      ) : (
        <p className="fu-empty">
          Nenhum retorno vencendo hoje. 🎉 Para agendar, abra um card no CRM e use “Agendar retorno”.
        </p>
      )}

      {upcoming.length > 0 && (
        <>
          <div className="fu-subtitle">Próximos retornos</div>
          <ul className="fu-list">
            {upcoming.slice(0, 5).map((item) => <Item key={item.cardId} item={item} onOpen={openInCrm} />)}
          </ul>
        </>
      )}
    </section>
  );
}
