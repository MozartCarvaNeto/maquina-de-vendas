// frontend/src/pages/Linhas.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './Linhas.css';

export default function Linhas() {
  const [callerNumbers, setCallerNumbers] = useState([]);
  const [agents, setAgents] = useState([]);
  const [numberForm, setNumberForm] = useState({ label: '', phoneNumber: '' });
  const [agentForm, setAgentForm] = useState({ name: '', phoneNumber: '' });
  const [editingNumberId, setEditingNumberId] = useState(null);
  const [editingAgentId, setEditingAgentId] = useState(null);
  const [editPhoneValue, setEditPhoneValue] = useState('');

  const loadData = useCallback(async () => {
    const [numbersRes, agentsRes] = await Promise.all([
      api.get('/lines/caller-numbers'),
      api.get('/lines/agents')
    ]);
    setCallerNumbers(numbersRes.data.callerNumbers);
    setAgents(agentsRes.data.agents);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleAddNumber(e) {
    e.preventDefault();
    try {
      await api.post('/lines/caller-numbers', numberForm);
      setNumberForm({ label: '', phoneNumber: '' });
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar número');
    }
  }

  async function handleAddAgent(e) {
    e.preventDefault();
    try {
      await api.post('/lines/agents', agentForm);
      setAgentForm({ name: '', phoneNumber: '' });
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar vendedor');
    }
  }

  async function toggleAgentActive(agent) {
    await api.put(`/lines/agents/${agent.id}`, { isActive: !agent.isActive });
    loadData();
  }

  async function toggleNumberActive(number) {
    await api.put(`/lines/caller-numbers/${number.id}`, { isActive: !number.isActive });
    loadData();
  }

  function startEditNumberPhone(number) {
    setEditingNumberId(number.id);
    setEditPhoneValue(number.phoneNumber);
  }

  async function saveNumberPhone(numberId) {
    try {
      await api.put(`/lines/caller-numbers/${numberId}`, { phoneNumber: editPhoneValue });
      setEditingNumberId(null);
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao atualizar telefone');
    }
  }

  function startEditAgentPhone(agent) {
    setEditingAgentId(agent.id);
    setEditPhoneValue(agent.phoneNumber);
  }

  async function saveAgentPhone(agentId) {
    try {
      await api.put(`/lines/agents/${agentId}`, { phoneNumber: editPhoneValue });
      setEditingAgentId(null);
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao atualizar telefone');
    }
  }

  async function removeNumber(id) {
    if (!window.confirm('Remover este número?')) return;
    try {
      await api.delete(`/lines/caller-numbers/${id}`);
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao remover número');
    }
  }

  async function removeAgent(id) {
    if (!window.confirm('Remover este vendedor?')) return;
    try {
      await api.delete(`/lines/agents/${id}`);
      loadData();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao remover vendedor');
    }
  }

  return (
    <div className="linhas-page">
      <header>
        <h1>Linhas e Equipe</h1>
        <p>Cadastre até 10 números de discagem e até 10 vendedores. O sistema distribui as ligações automaticamente em rodízio. Clique no telefone para editá-lo sem precisar excluir o cadastro.</p>
      </header>

      <div className="linhas-grid">
        <section className="card">
          <div className="card-header">
            <h3>📞 Números de Discagem</h3>
            <span className="badge">{callerNumbers.length}/10</span>
          </div>

          <form onSubmit={handleAddNumber} className="inline-form">
            <input placeholder="Rótulo (ex: Linha SP)" value={numberForm.label} onChange={(e) => setNumberForm({ ...numberForm, label: e.target.value })} required />
            <input placeholder="+5511999998888" value={numberForm.phoneNumber} onChange={(e) => setNumberForm({ ...numberForm, phoneNumber: e.target.value })} required />
            <button className="btn-primary" type="submit">Adicionar</button>
          </form>

          <ul className="line-list">
            {callerNumbers.map((n) => (
              <li key={n.id}>
                <div>
                  <strong>{n.label}</strong>
                  {editingNumberId === n.id ? (
                    <div className="inline-edit">
                      <input value={editPhoneValue} onChange={(e) => setEditPhoneValue(e.target.value)} />
                      <button className="btn-outline" onClick={() => saveNumberPhone(n.id)}>Salvar</button>
                      <button className="btn-danger-small" onClick={() => setEditingNumberId(null)}>Cancelar</button>
                    </div>
                  ) : (
                    <span className="editable-phone" onClick={() => startEditNumberPhone(n)} title="Clique para editar">
                      {n.phoneNumber} ✏️
                    </span>
                  )}
                </div>
                <div className="line-actions">
                  <label className="switch">
                    <input type="checkbox" checked={n.isActive} onChange={() => toggleNumberActive(n)} />
                    <span>{n.isActive ? 'Ativo' : 'Pausado'}</span>
                  </label>
                  <button className="btn-danger-small" onClick={() => removeNumber(n.id)}>Remover</button>
                </div>
              </li>
            ))}
            {callerNumbers.length === 0 && <p className="empty-state">Nenhum número cadastrado</p>}
          </ul>
        </section>

        <section className="card">
          <div className="card-header">
            <h3>👤 Vendedores</h3>
            <span className="badge">{agents.length}/10</span>
          </div>

          <form onSubmit={handleAddAgent} className="inline-form">
            <input placeholder="Nome do vendedor" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} required />
            <input placeholder="+5511988887777" value={agentForm.phoneNumber} onChange={(e) => setAgentForm({ ...agentForm, phoneNumber: e.target.value })} required />
            <button className="btn-primary" type="submit">Adicionar</button>
          </form>

          <ul className="line-list">
            {agents.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.name}</strong>
                  {editingAgentId === a.id ? (
                    <div className="inline-edit">
                      <input value={editPhoneValue} onChange={(e) => setEditPhoneValue(e.target.value)} />
                      <button className="btn-outline" onClick={() => saveAgentPhone(a.id)}>Salvar</button>
                      <button className="btn-danger-small" onClick={() => setEditingAgentId(null)}>Cancelar</button>
                    </div>
                  ) : (
                    <span className="editable-phone" onClick={() => startEditAgentPhone(a)} title="Clique para editar">
                      {a.phoneNumber} ✏️
                    </span>
                  )}
                </div>
                <div className="line-actions">
                  <span className={`status-pill ${a.status}`}>{a.status.replace('_', ' ')}</span>
                  <label className="switch">
                    <input type="checkbox" checked={a.isActive} onChange={() => toggleAgentActive(a)} />
                    <span>{a.isActive ? 'Ativo' : 'Pausado'}</span>
                  </label>
                  <button className="btn-danger-small" onClick={() => removeAgent(a.id)}>Remover</button>
                </div>
              </li>
            ))}
            {agents.length === 0 && <p className="empty-state">Nenhum vendedor cadastrado</p>}
          </ul>
        </section>
      </div>
    </div>
  );
}