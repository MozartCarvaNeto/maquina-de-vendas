// frontend/src/pages/Listas.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './Listas.css';

function emptyForm() {
  return {
    name: '',
    description: '',
    type: 'static',
    tagsAll: '',
    tagsAny: '',
    excludeTags: '',
    status: '',
    lastPurchaseWithinDays: '',
    neverPurchased: false
  };
}

export default function Listas() {
  const [lists, setLists] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [previewCount, setPreviewCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewingList, setViewingList] = useState(null);

  const loadLists = useCallback(async () => {
    const { data } = await api.get('/lead-lists');
    setLists(data.lists);
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  function buildFilterRules() {
    const rules = {};
    if (form.status) rules.status = form.status;
    if (form.tagsAll) rules.tagsAll = form.tagsAll.split(',').map((t) => t.trim()).filter(Boolean);
    if (form.tagsAny) rules.tagsAny = form.tagsAny.split(',').map((t) => t.trim()).filter(Boolean);
    if (form.excludeTags) rules.excludeTags = form.excludeTags.split(',').map((t) => t.trim()).filter(Boolean);
    if (form.lastPurchaseWithinDays) rules.lastPurchaseWithinDays = Number(form.lastPurchaseWithinDays);
    if (form.neverPurchased) rules.neverPurchased = true;
    return rules;
  }

  async function handlePreview() {
    const { data } = await api.post('/lead-lists/preview-dynamic', { filterRules: buildFilterRules() });
    setPreviewCount(data.count);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);

    const payload = {
      name: form.name,
      description: form.description,
      type: form.type,
      ...(form.type === 'dynamic' ? { filterRules: buildFilterRules() } : {})
    };

    try {
      await api.post('/lead-lists', payload);
      setShowModal(false);
      setForm(emptyForm());
      setPreviewCount(null);
      loadLists();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar lista');
    } finally {
      setSaving(false);
    }
  }

  async function handleView(list) {
    const { data } = await api.get(`/lead-lists/${list.id}`);
    setViewingList(data);
  }

  async function handleRemoveMember(listId, leadId) {
    await api.delete(`/lead-lists/${listId}/members/${leadId}`);
    handleView({ id: listId });
    loadLists();
  }

  async function handleDelete(id) {
    if (!window.confirm('Excluir esta lista? (os contatos não serão excluídos, só a lista)')) return;
    await api.delete(`/lead-lists/${id}`);
    loadLists();
  }

  return (
    <div className="listas-page">
      <header>
        <h1>Listas de Leads</h1>
        <p>
          Crie listas estáticas (contatos fixos, ex: importados de uma planilha específica) ou dinâmicas
          (recalculadas automaticamente, ex: "comprou nos últimos 30 dias"). Use-as como público-alvo na tela
          de Disparos.
        </p>
      </header>

      <div className="listas-toolbar">
        <button className="btn-primary" onClick={() => setShowModal(true)}>➕ Nova Lista</button>
      </div>

      <div className="listas-grid">
        {lists.map((list) => (
          <div className="card" key={list.id}>
            <div className="card-header">
              <h3>{list.name}</h3>
              <span className={`badge ${list.type === 'dynamic' ? 'badge-dynamic' : ''}`}>
                {list.type === 'dynamic' ? 'Dinâmica' : 'Estática'}
              </span>
            </div>
            {list.description && <p className="list-desc">{list.description}</p>}
            <p className="list-count">{list._count?.memberships ?? 0} contatos {list.type === 'dynamic' ? '(estimado)' : ''}</p>
            <div className="list-actions">
              <button className="btn-outline" onClick={() => handleView(list)}>Ver contatos</button>
              <button className="btn-danger-small" onClick={() => handleDelete(list.id)}>Excluir</button>
            </div>
          </div>
        ))}
        {lists.length === 0 && <p className="empty-state">Nenhuma lista criada ainda</p>}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
            <h2>Nova Lista</h2>
            <form onSubmit={handleCreate}>
              <label>Nome da lista</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />

              <label>Descrição (opcional)</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

              <label>Tipo</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="static">Estática (você adiciona os contatos manualmente ou via CSV)</option>
                <option value="dynamic">Dinâmica (regras automáticas)</option>
              </select>

              {form.type === 'dynamic' && (
                <>
                  <hr />
                  <p className="hint-text">Exemplos prontos: "visitou o site e não comprou" → Tags obrigatórias: visitou_site + Excluir tags: comprou. "Comprou nos últimos 30 dias" → Comprou nos últimos (dias): 30.</p>

                  <label>Status do funil (opcional)</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="">Qualquer status</option>
                    <option value="novo">Novo</option>
                    <option value="qualificado">Qualificado</option>
                    <option value="em_negociacao">Em negociação</option>
                    <option value="fechado">Fechado</option>
                    <option value="desqualificado">Desqualificado</option>
                  </select>

                  <label>Tags obrigatórias (precisa ter todas, separadas por vírgula)</label>
                  <input value={form.tagsAll} onChange={(e) => setForm({ ...form, tagsAll: e.target.value })} placeholder="ex: visitou_site" />

                  <label>Tags alternativas (precisa ter pelo menos uma)</label>
                  <input value={form.tagsAny} onChange={(e) => setForm({ ...form, tagsAny: e.target.value })} placeholder="ex: vip, recorrente" />

                  <label>Excluir quem tiver estas tags</label>
                  <input value={form.excludeTags} onChange={(e) => setForm({ ...form, excludeTags: e.target.value })} placeholder="ex: comprou" />

                  <label>Comprou nos últimos (dias)</label>
                  <input type="number" value={form.lastPurchaseWithinDays} onChange={(e) => setForm({ ...form, lastPurchaseWithinDays: e.target.value })} placeholder="ex: 30" />

                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.neverPurchased} onChange={(e) => setForm({ ...form, neverPurchased: e.target.checked })} />
                    Nunca comprou
                  </label>

                  <button type="button" className="btn-outline" onClick={handlePreview}>Ver tamanho estimado</button>
                  {previewCount !== null && <p className="hint-text">{previewCount} contatos correspondem a estas regras agora.</p>}
                </>
              )}

              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Criar lista'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewingList && (
        <div className="modal-overlay" onClick={() => setViewingList(null)}>
          <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
            <h2>{viewingList.list.name}</h2>
            <p className="hint-text">{viewingList.memberCount} contatos nesta lista</p>

            <div className="member-list">
              {viewingList.members.map((member) => (
                <div className="member-row" key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <span>{member.phone || member.email}</span>
                  </div>
                  {viewingList.list.type === 'static' && (
                    <button className="btn-danger-small" onClick={() => handleRemoveMember(viewingList.list.id, member.id)}>
                      Remover
                    </button>
                  )}
                </div>
              ))}
              {viewingList.members.length === 0 && <p className="empty-state">Nenhum contato nesta lista ainda</p>}
            </div>

            <div className="modal-actions">
              <button className="btn-outline" onClick={() => setViewingList(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}