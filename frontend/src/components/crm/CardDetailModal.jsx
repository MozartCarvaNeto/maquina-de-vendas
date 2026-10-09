// frontend/src/components/crm/CardDetailModal.jsx
import { useState } from 'react';
import api from '../../services/api';
import { refreshFollowUps } from '../../hooks/useFollowUps';
import { getFollowUpState, formatFollowUpLabel, toInputValue, inDaysAt, isLostColumn } from './followUpUtils';
import './FollowUps.css';

const LOST_REASONS = [
  'Sem interesse no momento',
  'Preço / orçamento',
  'Comprou do concorrente',
  'Não respondeu mais',
  'Fechou o negócio / sem demanda',
  'Outro'
];

export default function CardDetailModal({ card, column, columns = [], onClose, onSaved }) {
  const [notes, setNotes] = useState(card.notes || '');
  const [value, setValue] = useState(card.value || 0);
  const [saving, setSaving] = useState(false);

  const isLost = isLostColumn(column);
  const followState = getFollowUpState(card.followUpAt);

  // Retorno agendado
  const [fuDate, setFuDate] = useState(card.followUpAt ? toInputValue(card.followUpAt) : '');
  const [fuNote, setFuNote] = useState(card.followUpNote || '');
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneNote, setDoneNote] = useState('');
  const [nextDate, setNextDate] = useState('');

  // Perdidos
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState(LOST_REASONS[0]);
  const [lostDetail, setLostDetail] = useState('');
  const [revisitDate, setRevisitDate] = useState('');
  const [reactivateColumnId, setReactivateColumnId] = useState('');

  const [busy, setBusy] = useState(false);

  async function run(action, successRefresh = true) {
    setBusy(true);
    try {
      await action();
      if (successRefresh) refreshFollowUps();
      onSaved();
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível concluir a ação.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`/crm/cards/${card.id}`, { notes, value: Number(value) });
      onSaved();
    } catch (error) {
      console.error('Erro ao salvar card:', error);
      alert('Não foi possível salvar as alterações.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Remover este card do funil?')) return;
    await api.delete(`/crm/cards/${card.id}`);
    refreshFollowUps();
    onSaved();
  }

  const schedule = () => {
    if (!fuDate) return alert('Escolha a data e a hora do retorno.');
    return run(() => api.put(`/crm/cards/${card.id}/followup`, { followUpAt: new Date(fuDate).toISOString(), note: fuNote }));
  };
  const clearSchedule = () => run(() => api.put(`/crm/cards/${card.id}/followup`, { followUpAt: null }));
  const markDone = () =>
    run(() =>
      api.post(`/crm/cards/${card.id}/followup/done`, {
        note: doneNote,
        ...(nextDate ? { rescheduleAt: new Date(nextDate).toISOString() } : {})
      })
    );
  const markLost = () =>
    run(() =>
      api.post(`/crm/cards/${card.id}/lost`, {
        reason: [lostReason, lostDetail.trim()].filter(Boolean).join(' — '),
        ...(revisitDate ? { revisitAt: new Date(revisitDate).toISOString() } : {})
      })
    );
  const reactivate = () =>
    run(() => api.post(`/crm/cards/${card.id}/reactivate`, reactivateColumnId ? { targetColumnId: reactivateColumnId } : {}));

  const quick = (setter) => (
    <div className="fu-quick">
      <button type="button" onClick={() => setter(inDaysAt(1, 9))}>Amanhã 9h</button>
      <button type="button" onClick={() => setter(inDaysAt(3, 9))}>Em 3 dias</button>
      <button type="button" onClick={() => setter(inDaysAt(7, 9))}>Próxima semana</button>
      <button type="button" onClick={() => setter(inDaysAt(15, 9))}>Em 15 dias</button>
    </div>
  );

  const quickLong = (setter) => (
    <div className="fu-quick">
      <button type="button" onClick={() => setter(inDaysAt(30, 9))}>Em 30 dias</button>
      <button type="button" onClick={() => setter(inDaysAt(60, 9))}>Em 60 dias</button>
      <button type="button" onClick={() => setter(inDaysAt(90, 9))}>Em 90 dias</button>
    </div>
  );

  const destinationColumns = columns.filter((c) => !isLostColumn(c));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-followup" onClick={(e) => e.stopPropagation()}>
        <h2>{card.lead.name}</h2>
        <p className="modal-subtitle">{card.lead.phone} {card.lead.email ? `· ${card.lead.email}` : ''}</p>

        {/* ---------------- Retorno agendado ---------------- */}
        <div className={`fu-section ${followState ? `fu-state-${followState}` : ''} ${isLost && !followState ? 'fu-state-lost' : ''}`}>
          <h4>{isLost ? '📅 Revisitar este cliente' : '📅 Retorno agendado'}</h4>

          {card.followUpAt ? (
            <>
              <div className={`fu-status-line ${followState ? `fu-${followState}` : ''}`}>
                {followState === 'overdue' ? '⚠️ ' : '🔔 '}{formatFollowUpLabel(card.followUpAt)}
              </div>
              {card.followUpNote && <div className="fu-hint">📝 {card.followUpNote}</div>}

              {!doneOpen ? (
                <div className="fu-row">
                  <button type="button" className="fu-btn-small fu-btn-ok" disabled={busy} onClick={() => setDoneOpen(true)}>
                    ✅ Retorno feito
                  </button>
                  <button type="button" className="fu-btn-small fu-btn-danger" disabled={busy} onClick={clearSchedule}>
                    Remover agendamento
                  </button>
                </div>
              ) : (
                <div>
                  <label>O que aconteceu no retorno? (opcional)</label>
                  <input value={doneNote} onChange={(e) => setDoneNote(e.target.value)} placeholder="Ex.: falei com ele, vai responder amanhã" />
                  <label>Agendar o próximo retorno (opcional)</label>
                  <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
                  {quick(setNextDate)}
                  <div className="fu-row">
                    <button type="button" className="fu-btn-small fu-btn-ok" disabled={busy} onClick={markDone}>Confirmar retorno feito</button>
                    <button type="button" className="fu-btn-small fu-btn-neutral" onClick={() => setDoneOpen(false)}>Voltar</button>
                  </div>
                </div>
              )}

              <label>Reagendar para</label>
            </>
          ) : (
            <div className="fu-hint">Falou com o cliente e ele ainda não respondeu? Agende quando voltar a falar com ele.</div>
          )}

          <input type="datetime-local" value={fuDate} onChange={(e) => setFuDate(e.target.value)} />
          {quick(setFuDate)}
          <input value={fuNote} onChange={(e) => setFuNote(e.target.value)} placeholder="Lembrete (ex.: perguntar sobre o orçamento)" maxLength={300} />
          <div className="fu-row">
            <button type="button" className="fu-btn-small fu-btn-primary" disabled={busy || !fuDate} onClick={schedule}>
              {card.followUpAt ? 'Salvar novo horário' : 'Agendar retorno'}
            </button>
          </div>
          <div className="fu-hint">
            Você recebe o aviso na tela inicial no dia. Se passar do horário sem marcar “retorno feito”, o card fica vermelho.
          </div>
        </div>

        {/* ---------------- Perdidos ---------------- */}
        {isLost ? (
          <div className="fu-section fu-state-lost">
            <h4>🚫 Cliente perdido</h4>
            {card.lostAt && <div className="fu-hint">Marcado como perdido em {new Date(card.lostAt).toLocaleDateString('pt-BR')}.</div>}
            {card.lostReason && <div className="fu-hint">Motivo: {card.lostReason}</div>}
            <label>Reativar este lead em</label>
            <select value={reactivateColumnId} onChange={(e) => setReactivateColumnId(e.target.value)}>
              <option value="">Primeira coluna do funil</option>
              {destinationColumns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="fu-row">
              <button type="button" className="fu-btn-small fu-btn-ok" disabled={busy} onClick={reactivate}>♻️ Reativar lead</button>
            </div>
            <div className="fu-hint">Use a data de “Revisitar” acima para lembrar de voltar a falar com ele quando houver uma nova promoção.</div>
          </div>
        ) : (
          <div className="fu-section">
            {!lostOpen ? (
              <div className="fu-row" style={{ marginTop: 0 }}>
                <button type="button" className="fu-btn-small fu-btn-danger" onClick={() => setLostOpen(true)}>🚫 Marcar como perdido</button>
                <span className="fu-hint">Vai para a coluna “Perdidos” e você pode voltar a ele no futuro.</span>
              </div>
            ) : (
              <div>
                <h4>🚫 Marcar como perdido</h4>
                <label>Motivo</label>
                <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                  {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <input style={{ marginTop: 8 }} value={lostDetail} onChange={(e) => setLostDetail(e.target.value)} placeholder="Detalhe (opcional)" maxLength={200} />
                <label>Revisitar em (opcional — para oferecer uma nova promoção)</label>
                <input type="datetime-local" value={revisitDate} onChange={(e) => setRevisitDate(e.target.value)} />
                {quickLong(setRevisitDate)}
                <div className="fu-row">
                  <button type="button" className="fu-btn-small fu-btn-danger" disabled={busy} onClick={markLost}>Mover para Perdidos</button>
                  <button type="button" className="fu-btn-small fu-btn-neutral" onClick={() => setLostOpen(false)}>Cancelar</button>
                </div>
              </div>
            )}
          </div>
        )}

        <label>Valor do negócio (R$)</label>
        <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />

        <label>Notas</label>
        <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />

        <div className="modal-actions">
          <button className="btn-danger" onClick={handleDelete}>Excluir</button>
          <div>
            <button className="btn-outline" onClick={onClose}>Cancelar</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
