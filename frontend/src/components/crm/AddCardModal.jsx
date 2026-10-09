// frontend/src/components/crm/AddCardModal.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';

export default function AddCardModal({ columns, defaultColumnId, onClose, onAdded }) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [columnId, setColumnId] = useState(defaultColumnId || columns[0]?.id || '');
  const [saving, setSaving] = useState(false);

  const searchLeads = useCallback(async () => {
    if (!search.trim()) {
      setResults([]);
      return;
    }
    const { data } = await api.get('/leads', { params: { search, pageSize: 10 } });
    setResults(data.leads);
  }, [search]);

  useEffect(() => {
    const timeout = setTimeout(searchLeads, 300);
    return () => clearTimeout(timeout);
  }, [searchLeads]);

  async function handleAdd() {
    if (!selectedLeadId || !columnId) return;
    setSaving(true);
    try {
      await api.post(`/crm/columns/${columnId}/cards`, { leadId: selectedLeadId });
      onAdded();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar lead ao quadro');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Adicionar lead ao quadro</h2>

        <label>Buscar contato</label>
        <input
          placeholder="Nome, telefone ou e-mail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {results.length > 0 && (
          <div className="add-card-results">
            {results.map((lead) => (
              <div
                key={lead.id}
                className={`add-card-result-item ${selectedLeadId === lead.id ? 'selected' : ''}`}
                onClick={() => setSelectedLeadId(lead.id)}
              >
                <strong>{lead.name}</strong>
                <span>{lead.phone || lead.email}</span>
              </div>
            ))}
          </div>
        )}

        <label>Coluna de destino</label>
        <select value={columnId} onChange={(e) => setColumnId(e.target.value)}>
          {columns.map((col) => (
            <option key={col.id} value={col.id}>{col.name}</option>
          ))}
        </select>

        <div className="modal-actions">
          <button className="btn-outline" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={!selectedLeadId || saving} onClick={handleAdd}>
            {saving ? 'Adicionando...' : 'Adicionar ao quadro'}
          </button>
        </div>
      </div>
    </div>
  );
}