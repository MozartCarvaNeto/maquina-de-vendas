// frontend/src/pages/Campanhas.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import './Campanhas.css';

const STEP_TYPES = [
  { value: 'number_min', label: 'Número mínimo (ex: renda mínima)' },
  { value: 'number_max', label: 'Número máximo (ex: idade máxima)' },
  { value: 'boolean_true', label: 'Sim/Não (precisa ser "sim")' },
  { value: 'one_of', label: 'Uma opção da lista' }
];

function emptyStep() {
  return { id: '', question: '', type: 'boolean_true', minValue: '', maxValue: '', acceptedValues: '' };
}

function emptyForm() {
  return {
    name: '',
    enterpriseName: '',
    active: true,
    firstMessage: '',
    botPrompt: '',
    aiProviderOverride: '',
    followUpEnabled: true,
    followUpDays: 7,
    followUpMessage: '',
    nutritionDays: 30,
    nutritionMessage: '',
    qualificationLogic: 'ALL',
    steps: [emptyStep()]
  };
}

export default function Campanhas() {
  const [campaigns, setCampaigns] = useState([]);
  const [aiProviders, setAiProviders] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const loadCampaigns = useCallback(async () => {
    const { data } = await api.get('/campaigns');
    setCampaigns(data.campaigns);
  }, []);

  const loadAiProviders = useCallback(async () => {
    const { data } = await api.get('/settings/ai');
    setAiProviders(data.providers);
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadAiProviders();
  }, [loadCampaigns, loadAiProviders]);

  function openCreateModal() {
    setForm(emptyForm());
    setEditingId(null);
    setShowModal(true);
  }

  async function openEditModal(campaign) {
    setEditingId(campaign.id);
    setForm({
      name: campaign.name,
      enterpriseName: campaign.enterpriseName || '',
      active: campaign.active,
      firstMessage: campaign.firstMessage || '',
      botPrompt: campaign.botPrompt || '',
      aiProviderOverride: campaign.aiProviderOverride || '',
      followUpEnabled: campaign.followUpEnabled,
      followUpDays: campaign.followUpDays,
      followUpMessage: campaign.followUpMessage || '',
      nutritionDays: campaign.nutritionDays,
      nutritionMessage: campaign.nutritionMessage || '',
      qualificationLogic: campaign.qualificationRules?.logic || 'ALL',
      steps:
        campaign.qualificationRules?.steps?.map((s) => ({
          id: s.id,
          question: s.question,
          type: s.type,
          minValue: s.minValue ?? '',
          maxValue: s.maxValue ?? '',
          acceptedValues: (s.acceptedValues || []).join(', ')
        })) || [emptyStep()]
    });
    setShowModal(true);
  }

  function updateStep(index, field, value) {
    setForm((prev) => {
      const steps = [...prev.steps];
      steps[index] = { ...steps[index], [field]: value };
      return { ...prev, steps };
    });
  }

  function addStep() {
    setForm((prev) => ({ ...prev, steps: [...prev.steps, emptyStep()] }));
  }

  function removeStep(index) {
    setForm((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }));
  }

  function buildQualificationRules() {
    return {
      logic: form.qualificationLogic,
      steps: form.steps
        .filter((s) => s.id && s.question)
        .map((s) => {
          const step = { id: s.id, question: s.question, type: s.type };
          if (s.type === 'number_min') step.minValue = Number(s.minValue) || 0;
          if (s.type === 'number_max') step.maxValue = Number(s.maxValue) || 0;
          if (s.type === 'one_of') {
            step.acceptedValues = s.acceptedValues.split(',').map((v) => v.trim()).filter(Boolean);
          }
          return step;
        })
    };
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);

    const payload = {
      name: form.name,
      enterpriseName: form.enterpriseName,
      active: form.active,
      firstMessage: form.firstMessage,
      botPrompt: form.botPrompt,
      aiProviderOverride: form.aiProviderOverride || null,
      followUpEnabled: form.followUpEnabled,
      followUpDays: Number(form.followUpDays),
      followUpMessage: form.followUpMessage,
      nutritionDays: Number(form.nutritionDays),
      nutritionMessage: form.nutritionMessage,
      qualificationRules: buildQualificationRules()
    };

    try {
      if (editingId) {
        await api.put(`/campaigns/${editingId}`, payload);
      } else {
        await api.post('/campaigns', payload);
      }
      setShowModal(false);
      loadCampaigns();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao salvar campanha');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Excluir esta campanha? Os leads vinculados a ela ficarão sem campanha.')) return;
    await api.delete(`/campaigns/${id}`);
    loadCampaigns();
  }

  return (
    <div className="campanhas-page">
      <header>
        <h1>Campanhas de Qualificação</h1>
        <p>Configure as perguntas que qualificam automaticamente seus leads e o comportamento do bot de IA.</p>
      </header>

      <div className="campanhas-toolbar">
        <button className="btn-primary" onClick={openCreateModal}>➕ Nova Campanha</button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr><th>Nome</th><th>Empresa</th><th>Leads</th><th>Status</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.enterpriseName || '-'}</td>
                <td>{c._count?.leads ?? 0}</td>
                <td><span className={`status-tag ${c.active ? 'active' : 'inactive'}`}>{c.active ? 'Ativa' : 'Inativa'}</span></td>
                <td>
                  <button className="btn-outline" onClick={() => openEditModal(c)}>Editar</button>
                  <button className="btn-danger-small" onClick={() => handleDelete(c.id)}>Excluir</button>
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={5} className="empty-state">Nenhuma campanha criada ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? 'Editar Campanha' : 'Nova Campanha'}</h2>

            <form onSubmit={handleSave}>
              <div className="form-row">
                <div>
                  <label>Nome da campanha</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </div>
                <div>
                  <label>Empreendimento/Empresa</label>
                  <input value={form.enterpriseName} onChange={(e) => setForm({ ...form, enterpriseName: e.target.value })} />
                </div>
              </div>

              <label>Primeira mensagem (enviada ao lead assim que entra na campanha)</label>
              <textarea rows={2} value={form.firstMessage} onChange={(e) => setForm({ ...form, firstMessage: e.target.value })} />

              <label>Prompt do bot de IA (instrução de comportamento)</label>
              <textarea rows={4} value={form.botPrompt} onChange={(e) => setForm({ ...form, botPrompt: e.target.value })} placeholder="Ex: Você é um assistente de vendas do Residencial X. Seja cordial, pergunte a renda e se tem entrada disponível." />

              <label>Provedor de IA desta campanha</label>
              <select value={form.aiProviderOverride} onChange={(e) => setForm({ ...form, aiProviderOverride: e.target.value })}>
                <option value="">Usar o provedor padrão da conta</option>
                {aiProviders.map((p) => (
                  <option key={p} value={p}>{p === 'gemini' ? 'Google Gemini' : p === 'openai' ? 'OpenAI ChatGPT' : p}</option>
                ))}
              </select>
              {aiProviders.length === 0 && (
                <p className="hint-text">Nenhum provedor de IA configurado ainda. Configure em Configurações → Inteligência Artificial.</p>
              )}

              <hr />
              <h3>Regras de Qualificação</h3>
              <label>Lógica</label>
              <select value={form.qualificationLogic} onChange={(e) => setForm({ ...form, qualificationLogic: e.target.value })}>
                <option value="ALL">Precisa passar em TODAS as etapas</option>
                <option value="ANY">Precisa passar em QUALQUER etapa</option>
              </select>

              {form.steps.map((step, index) => (
                <div className="step-row" key={index}>
                  <input
                    placeholder="ID (ex: renda_minima)"
                    value={step.id}
                    onChange={(e) => updateStep(index, 'id', e.target.value)}
                  />
                  <input
                    placeholder="Pergunta ao lead"
                    value={step.question}
                    onChange={(e) => updateStep(index, 'question', e.target.value)}
                  />
                  <select value={step.type} onChange={(e) => updateStep(index, 'type', e.target.value)}>
                    {STEP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>

                  {step.type === 'number_min' && (
                    <input type="number" placeholder="Valor mínimo" value={step.minValue} onChange={(e) => updateStep(index, 'minValue', e.target.value)} />
                  )}
                  {step.type === 'number_max' && (
                    <input type="number" placeholder="Valor máximo" value={step.maxValue} onChange={(e) => updateStep(index, 'maxValue', e.target.value)} />
                  )}
                  {step.type === 'one_of' && (
                    <input placeholder="Opções aceitas, separadas por vírgula" value={step.acceptedValues} onChange={(e) => updateStep(index, 'acceptedValues', e.target.value)} />
                  )}

                  <button type="button" className="btn-danger-small" onClick={() => removeStep(index)}>Remover</button>
                </div>
              ))}
              <button type="button" className="btn-outline" onClick={addStep}>➕ Adicionar etapa</button>

              <hr />
              <h3>Follow-up e Nutrição</h3>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.followUpEnabled} onChange={(e) => setForm({ ...form, followUpEnabled: e.target.checked })} />
                Ativar follow-up/nutrição automática
              </label>

              <div className="form-row">
                <div>
                  <label>Follow-up após (dias sem resposta)</label>
                  <input type="number" value={form.followUpDays} onChange={(e) => setForm({ ...form, followUpDays: e.target.value })} />
                </div>
                <div>
                  <label>Nutrição após (dias sem resposta)</label>
                  <input type="number" value={form.nutritionDays} onChange={(e) => setForm({ ...form, nutritionDays: e.target.value })} />
                </div>
              </div>

              <label>Mensagem de follow-up</label>
              <textarea rows={2} value={form.followUpMessage} onChange={(e) => setForm({ ...form, followUpMessage: e.target.value })} />

              <label>Mensagem de nutrição</label>
              <textarea rows={2} value={form.nutritionMessage} onChange={(e) => setForm({ ...form, nutritionMessage: e.target.value })} />

              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar campanha'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}