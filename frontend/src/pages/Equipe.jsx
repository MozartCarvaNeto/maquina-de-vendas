// frontend/src/pages/Equipe.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './Equipe.css';

const ROLE_LABELS = { owner: 'Proprietário', admin: 'Administrador', vendedor: 'Vendedor' };

function emptyForm() {
  return { name: '', email: '', role: 'vendedor', agentId: '' };
}

export default function Equipe() {
  const [members, setMembers] = useState([]);
  const [agents, setAgents] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState(null);

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');

  const loadMembers = useCallback(async () => {
    const { data } = await api.get('/team');
    setMembers(data.members);
  }, []);

  const loadAgents = useCallback(async () => {
    // Plano sem módulos de ligação: a lista de ramais não existe, e tudo bem.
    const { data } = await api.get('/lines/agents').catch(() => ({ data: { agents: [] } }));
    setAgents(data.agents);
  }, []);

  useEffect(() => {
    loadMembers();
    loadAgents();
  }, [loadMembers, loadAgents]);

  async function handleInvite(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.post('/team', {
        name: form.name,
        email: form.email,
        role: form.role,
        agentId: form.agentId || undefined
      });
      setGeneratedPassword({ email: form.email, password: data.tempPassword });
      setForm(emptyForm());
      loadMembers();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao convidar usuário');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeRole(member, role) {
    try {
      await api.put(`/team/${member.id}`, { role });
      loadMembers();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao alterar papel');
    }
  }

  async function handleToggleStatus(member) {
    const newStatus = member.status === 'ativo' ? 'inativo' : 'ativo';
    try {
      await api.put(`/team/${member.id}`, { status: newStatus });
      loadMembers();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao alterar status');
    }
  }

  async function handleLinkAgent(member, agentId) {
    try {
      await api.put(`/team/${member.id}`, { agentId: agentId || null });
      loadMembers();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao vincular vendedor');
    }
  }

  async function handleResetPassword(member) {
    if (!window.confirm(`Definir uma nova senha temporária para ${member.name}?`)) return;
    try {
      const { data } = await api.post(`/team/${member.id}/reset-password`);
      setGeneratedPassword({ email: member.email, password: data.tempPassword });
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao redefinir senha');
    }
  }

  async function handleRemove(member) {
    if (!window.confirm(`Remover ${member.name} da equipe?`)) return;
    try {
      await api.delete(`/team/${member.id}`);
      loadMembers();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao remover usuário');
    }
  }

  return (
    <div className="equipe-page">
      <header>
        <h1>Equipe</h1>
        <p>Cada vendedor tem seu próprio login. Vincule cada login a um número de telefone (Linhas) para que o Discador saiba para quem bridgear as ligações atendidas por ele.</p>
      </header>

      <div className="equipe-toolbar">
        <button className="btn-primary" onClick={() => setShowModal(true)}>➕ Convidar usuário</button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Telefone vinculado</th><th>Status</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.name} {m.id === currentUser.id && <span className="secondary-text">(você)</span>}</td>
                <td>{m.email}</td>
                <td>
                  {m.role === 'owner' ? (
                    <span className="role-tag role-owner">Proprietário</span>
                  ) : (
                    <select value={m.role} onChange={(e) => handleChangeRole(m, e.target.value)}>
                      <option value="admin">Administrador</option>
                      <option value="vendedor">Vendedor</option>
                    </select>
                  )}
                </td>
                <td>
                  <select value={m.agentId || ''} onChange={(e) => handleLinkAgent(m, e.target.value)}>
                    <option value="">Nenhum</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.phoneNumber})</option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`status-tag ${m.status === 'ativo' ? 'active' : 'inactive'}`}>{m.status}</span>
                </td>
                <td className="equipe-actions">
                  {m.role !== 'owner' && (
                    <button className="btn-outline" onClick={() => handleToggleStatus(m)}>
                      {m.status === 'ativo' ? 'Desativar' : 'Reativar'}
                    </button>
                  )}
                  <button className="btn-outline" onClick={() => handleResetPassword(m)}>Nova senha</button>
                  {m.role !== 'owner' && m.id !== currentUser.id && (
                    <button className="btn-danger-small" onClick={() => handleRemove(m)}>Remover</button>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && <tr><td colSpan={6} className="empty-state">Nenhum usuário</td></tr>}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Convidar usuário</h2>
            <form onSubmit={handleInvite}>
              <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input placeholder="E-mail de login" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="vendedor">Vendedor</option>
                <option value="admin">Administrador</option>
              </select>
              <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
                <option value="">Sem telefone vinculado (vincular depois)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.phoneNumber})</option>
                ))}
              </select>
              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Convidar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {generatedPassword && (
        <div className="modal-overlay" onClick={() => setGeneratedPassword(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Senha temporária gerada</h2>
            <p className="hint-text">Compartilhe estas credenciais com o usuário por um canal seguro. Elas não serão mostradas novamente.</p>
            <div className="temp-password-box">
              <div><strong>E-mail:</strong> {generatedPassword.email}</div>
              <div><strong>Senha:</strong> {generatedPassword.password}</div>
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={() => setGeneratedPassword(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}