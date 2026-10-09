// frontend/src/pages/Contatos.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import ChannelBadge from '../components/leads/ChannelBadge';
import './Contatos.css';

const PAGE_SIZE = 50;

export default function Contatos() {
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [lists, setLists] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    tags: '',
    consentSource: '',
    preferredChannel: ''
  });

  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkCampaignId, setBulkCampaignId] = useState('');
  const [bulkChannel, setBulkChannel] = useState('');
  const [bulkListId, setBulkListId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const loadLeads = useCallback(async () => {
    const { data } = await api.get('/leads', { params: { search, page, pageSize: PAGE_SIZE } });
    setLeads(data.leads);
    setTotal(data.total);
    setTotalPages(data.totalPages || 1);
    setSelectedIds([]);
  }, [search, page]);

  const loadLists = useCallback(async () => {
    const { data } = await api.get('/lead-lists');
    setLists(data.lists.filter((l) => l.type === 'static'));
  }, []);

  const loadCampaigns = useCallback(async () => {
    const { data } = await api.get('/campaigns');
    setCampaigns(data.campaigns);
  }, []);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  useEffect(() => {
    loadLists();
    loadCampaigns();
  }, [loadLists, loadCampaigns]);

  // Sempre que a busca muda, volta para a página 1
  useEffect(() => {
    setPage(1);
  }, [search]);

  async function handleCreate(e) {
    e.preventDefault();

    if (!form.phone && !form.email) {
      alert('Informe pelo menos um contato: telefone ou e-mail');
      return;
    }

    try {
      await api.post('/leads', {
        name: form.name,
        phone: form.phone || undefined,
        email: form.email || undefined,
        address: form.address || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        consentSource: form.consentSource,
        preferredChannel: form.preferredChannel || undefined
      });
      setShowModal(false);
      setForm({ name: '', phone: '', email: '', address: '', tags: '', consentSource: '', preferredChannel: '' });
      loadLeads();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar contato');
    }
  }

  async function handleCall(leadId) {
    try {
      await api.post('/calls/click-to-call', { leadId });
      alert('Ligação iniciada! Seu telefone vai tocar quando o lead atender.');
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao iniciar ligação');
    }
  }

  async function handleImportCsv(e) {
    const file = e.target.files[0];
    if (!file) return;

    const consentSource = prompt('Origem desta lista (ex: importacao_csv_evento_x):');
    if (!consentSource) return;

    let listId = '';
    if (lists.length > 0) {
      const listNames = lists.map((l, i) => `${i + 1}. ${l.name}`).join('\n');
      const choice = prompt(
        `Deseja adicionar estes contatos a uma Lista estática existente?\nDigite o número da lista, ou deixe em branco para não adicionar:\n\n${listNames}`
      );
      const index = Number(choice) - 1;
      if (lists[index]) listId = lists[index].id;
    }

    const tags = prompt('Etiquetas a aplicar em todos os contatos importados (opcional, separadas por vírgula):') || '';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('consentSource', consentSource);
    if (listId) formData.append('listId', listId);
    if (tags) formData.append('tags', tags);

    try {
      const { data } = await api.post('/leads/import-csv', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      alert(
        `${data.imported} contatos importados, ${data.skipped} ignorados` +
          (data.skippedReasons?.length ? `.\n\nMotivos:\n${data.skippedReasons.join('\n')}` : '.')
      );
      setPage(1);
      loadLeads();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao importar arquivo');
    }
    e.target.value = '';
  }

  function toggleSelect(leadId) {
    setSelectedIds((prev) => (prev.includes(leadId) ? prev.filter((id) => id !== leadId) : [...prev, leadId]));
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.length === leads.length ? [] : leads.map((l) => l.id)));
  }

  async function handleBulkAssignCampaign() {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/leads/bulk/campaign', {
        leadIds: selectedIds,
        campaignId: bulkCampaignId || null
      });
      alert(`${data.updated} contatos movidos de campanha.`);
      loadLeads();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao mover para campanha');
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkSetChannel() {
    if (selectedIds.length === 0 || !bulkChannel) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/leads/bulk/channel', {
        leadIds: selectedIds,
        preferredChannel: bulkChannel === 'auto' ? null : bulkChannel
      });
      alert(
        `${data.updated} contatos atualizados, ${data.skipped} ignorados` +
          (data.skippedReasons?.length ? `.\n\nMotivos:\n${data.skippedReasons.join('\n')}` : '.')
      );
      loadLeads();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao definir canal');
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkEnqueueCalls() {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/leads/bulk/enqueue-calls', { leadIds: selectedIds });
      alert(
        `${data.enqueued} contatos adicionados à fila de discagem, ${data.skipped} ignorados` +
          (data.skippedReasons?.length ? `.\n\nMotivos:\n${data.skippedReasons.join('\n')}` : '.')
      );
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar à fila de discagem');
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkAddToList() {
    if (selectedIds.length === 0 || !bulkListId) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post(`/lead-lists/${bulkListId}/members`, { leadIds: selectedIds });
      alert(`${data.added} contatos adicionados à lista.`);
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar à lista');
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkAddToCrm() {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/leads/bulk/add-to-crm', { leadIds: selectedIds });
      alert(
        `${data.added} contatos adicionados ao quadro "${data.columnName}" do CRM, ${data.skipped} já tinham card.`
      );
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao adicionar ao CRM');
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="contatos-page">
      <header>
        <h1>Base de Contatos</h1>
        <p>
          Cada contato precisa de nome e pelo menos um canal de contato (telefone ou e-mail). Selecione vários
          contatos para remanejá-los entre campanhas, canais e o CRM.
        </p>
      </header>

      <div className="contatos-actions">
        <input
          placeholder="Buscar por nome, telefone ou e-mail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="btn-outline">
          📤 Importar CSV/Excel
          <input type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleImportCsv} />
        </label>
        <button className="btn-primary" onClick={() => setShowModal(true)}>➕ Novo Contato</button>
      </div>

      {selectedIds.length > 0 && (
        <div className="bulk-toolbar">
          <strong>{selectedIds.length} selecionado(s)</strong>

          <div className="bulk-action">
            <select value={bulkCampaignId} onChange={(e) => setBulkCampaignId(e.target.value)}>
              <option value="">Remover campanha</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className="btn-outline" disabled={bulkBusy} onClick={handleBulkAssignCampaign}>
              Mover para campanha
            </button>
          </div>

          <div className="bulk-action">
            <select value={bulkChannel} onChange={(e) => setBulkChannel(e.target.value)}>
              <option value="">Selecione o canal</option>
              <option value="auto">Automático (todos os canais aplicáveis)</option>
              <option value="whatsapp">💬 WhatsApp</option>
              <option value="call">📞 Ligação</option>
              <option value="email">📧 E-mail</option>
            </select>
            <button className="btn-outline" disabled={bulkBusy || !bulkChannel} onClick={handleBulkSetChannel}>
              Definir canal
            </button>
          </div>

          <div className="bulk-action">
            <select value={bulkListId} onChange={(e) => setBulkListId(e.target.value)}>
              <option value="">Selecione a lista</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <button className="btn-outline" disabled={bulkBusy || !bulkListId} onClick={handleBulkAddToList}>
              Adicionar à lista
            </button>
          </div>

          <button className="btn-outline" disabled={bulkBusy} onClick={handleBulkAddToCrm}>
            📋 Adicionar ao CRM
          </button>

          <button className="btn-primary" disabled={bulkBusy} onClick={handleBulkEnqueueCalls}>
            📞 Adicionar à fila de discagem
          </button>
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={leads.length > 0 && selectedIds.length === leads.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Nome</th>
              <th>Contato</th>
              <th>Canal / Avisos</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className={selectedIds.includes(lead.id) ? 'row-selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(lead.id)}
                    onChange={() => toggleSelect(lead.id)}
                  />
                </td>
                <td>{lead.name}</td>
                <td>
                  {lead.phone && <div>{lead.phone}</div>}
                  {lead.email && <div className="secondary-text">{lead.email}</div>}
                  {!lead.phone && !lead.email && <span className="secondary-text">Sem contato</span>}
                </td>
                <td><ChannelBadge lead={lead} /></td>
                <td><span className="status-tag">{lead.status}</span></td>
                <td>
                  {lead.phone ? (
                    <button className="btn-outline" onClick={() => handleCall(lead.id)}>📞 Ligar</button>
                  ) : (
                    <span className="secondary-text">—</span>
                  )}
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr><td colSpan={6} className="empty-state">Nenhum contato encontrado</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="pagination-bar">
          <span>
            Mostrando {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} de {total} contatos
          </span>
          <div className="pagination-controls">
            <button className="btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Anterior
            </button>
            <span className="pagination-page">Página {page} de {totalPages}</span>
            <button className="btn-outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Próxima →
            </button>
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo Contato</h2>
            <form onSubmit={handleCreate}>
              <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input placeholder="Telefone (com DDI) — opcional se tiver e-mail" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input placeholder="E-mail — opcional se tiver telefone" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <input placeholder="Endereço (opcional)" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <input placeholder="Tags, separadas por vírgula (opcional)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              <select value={form.preferredChannel} onChange={(e) => setForm({ ...form, preferredChannel: e.target.value })}>
                <option value="">Canal automático (todos os aplicáveis)</option>
                <option value="whatsapp">💬 Preferir WhatsApp</option>
                <option value="call">📞 Preferir Ligação</option>
                <option value="email">📧 Preferir E-mail</option>
              </select>
              <input
                placeholder="Origem do consentimento (ex: formulario_site)"
                value={form.consentSource}
                onChange={(e) => setForm({ ...form, consentSource: e.target.value })}
                required
              />
              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}