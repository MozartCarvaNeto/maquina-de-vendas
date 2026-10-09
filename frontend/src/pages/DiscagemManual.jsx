// frontend/src/pages/DiscagemManual.jsx
//
// Discagem manual: mostra um contato de cada vez, o vendedor liga pelo
// próprio telefone (toca no número no celular, ou disca no computador) e
// registra o resultado. Funciona bem tanto no celular quanto no PC.
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './DiscagemManual.css';

const CONFIRM_LABEL = {
  nao_atendeu: '📵 Marcado como "não atendeu" — ele volta ao fim da fila.',
  nao_quer_remover: '🚫 Removido da lista.',
  nao_quer_pausar: '⏸️ Pausado por 3 meses.',
  interessado: '🔥 Adicionado ao CRM!'
};

export default function DiscagemManual() {
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState('');
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNaoQuer, setShowNaoQuer] = useState(false);
  const [showInteressado, setShowInteressado] = useState(false);
  const [note, setNote] = useState('');
  const [lastConfirmation, setLastConfirmation] = useState(null);
  const [sending, setSending] = useState(false);

  const loadLists = useCallback(async () => {
    const { data } = await api.get('/call-queue/lists');
    setLists(data.lists);
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  const loadQueue = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/call-queue/${id}`);
      setState(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setShowNaoQuer(false);
    setShowInteressado(false);
    setNote('');
    setLastConfirmation(null);
    if (listId) loadQueue(listId);
    else setState(null);
  }, [listId, loadQueue]);

  function resetPanels() {
    setShowNaoQuer(false);
    setShowInteressado(false);
    setNote('');
  }

  async function sendOutcome(outcome, extra = {}) {
    if (!state?.current) return;
    setSending(true);
    try {
      const { data } = await api.post(`/call-queue/${listId}/outcome`, {
        leadId: state.current.lead.id,
        outcome,
        ...extra
      });
      setState(data);
      setLastConfirmation(CONFIRM_LABEL[outcome]);
      resetPanels();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao registrar o resultado.');
    } finally {
      setSending(false);
    }
  }

  async function undo() {
    setSending(true);
    try {
      const { data } = await api.post(`/call-queue/${listId}/undo`);
      setState(data);
      setLastConfirmation(null);
      resetPanels();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao desfazer.');
    } finally {
      setSending(false);
    }
  }

  const lead = state?.current?.lead;
  const telHref = lead?.phone ? `tel:${lead.phone.replace(/[^\d+]/g, '')}` : null;

  return (
    <div className="dm-page">
      <div className="dm-picker">
        <label>Qual lista você quer ligar agora?</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">Selecione uma lista</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name} ({l.totalContacts})</option>
          ))}
        </select>
      </div>

      {loading && <p className="dm-hint">Carregando…</p>}

      {!loading && listId && state && (
        <>
          <div className="dm-counters">
            <span>📞 {state.counts.restantes} na fila</span>
            <span>⏸️ {state.counts.pausados} pausados</span>
            <span>🔥 {state.counts.interessados} interessados</span>
          </div>

          {lastConfirmation && (
            <div className="dm-confirmation">
              {lastConfirmation}
              {state.canUndo && <button className="dm-undo" onClick={undo} disabled={sending}>↩ Desfazer</button>}
            </div>
          )}

          {!lead ? (
            <div className="dm-done">
              🎉 Fila concluída! Não há mais ninguém pra ligar agora nesta lista
              {state.counts.pausados > 0 && ` (${state.counts.pausados} contato(s) voltam depois de pausados)`}.
            </div>
          ) : (
            <div className="dm-card">
              <div className="dm-lead-name">{lead.name}</div>
              {telHref ? (
                <a className="dm-lead-phone" href={telHref}>📞 {lead.phone}</a>
              ) : (
                <div className="dm-lead-phone dm-lead-phone-missing">Sem telefone cadastrado</div>
              )}
              {state.current.lastOutcome === 'nao_atendeu' && (
                <div className="dm-retry-tag">🔁 Tentativa novamente — não atendeu da última vez</div>
              )}

              {!showNaoQuer && !showInteressado && (
                <div className="dm-actions">
                  <button className="dm-btn dm-btn-muted" disabled={sending} onClick={() => sendOutcome('nao_atendeu')}>
                    📵 Não atendeu
                  </button>
                  <button className="dm-btn dm-btn-danger" disabled={sending} onClick={() => setShowNaoQuer(true)}>
                    🚫 Não quer
                  </button>
                  <button className="dm-btn dm-btn-success" disabled={sending} onClick={() => setShowInteressado(true)}>
                    🔥 Gostou, quer mais informações
                  </button>
                  {state.canUndo && <button className="dm-undo dm-undo-standalone" onClick={undo} disabled={sending}>↩ Desfazer última ação</button>}
                </div>
              )}

              {showNaoQuer && (
                <div className="dm-subpanel">
                  <p>O que fazer com este contato?</p>
                  <button className="dm-btn dm-btn-danger" disabled={sending} onClick={() => sendOutcome('nao_quer_remover')}>
                    Retirar da lista definitivamente
                  </button>
                  <button className="dm-btn dm-btn-muted" disabled={sending} onClick={() => sendOutcome('nao_quer_pausar')}>
                    Pausar por 3 meses (tentar de novo depois)
                  </button>
                  <button className="dm-btn dm-btn-link" onClick={() => setShowNaoQuer(false)}>Cancelar</button>
                </div>
              )}

              {showInteressado && (
                <div className="dm-subpanel">
                  <p>O que o contato disse? (vai junto no card do CRM)</p>
                  <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex: gostou da proposta, quer falar de novo semana que vem…" />
                  <button className="dm-btn dm-btn-success" disabled={sending} onClick={() => sendOutcome('interessado', { note })}>
                    Salvar e adicionar ao CRM
                  </button>
                  <button className="dm-btn dm-btn-link" onClick={() => setShowInteressado(false)}>Cancelar</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
