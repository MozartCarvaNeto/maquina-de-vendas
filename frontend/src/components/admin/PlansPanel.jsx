// frontend/src/components/admin/PlansPanel.jsx
//
// Cadastro dos PLANOS que você vende: preço, ciclo de cobrança, limites e
// MÓDULOS (quais partes do sistema o plano libera). Limite vazio = sem limite.
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';

const CYCLE_LABEL = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// "99,90" / "1.299,90" / "99.90" -> centavos
function reaisToCents(text) {
  const clean = String(text).trim().replace(/[^\d.,]/g, '');
  if (!clean) return NaN;
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  return Math.round(parseFloat(normalized) * 100);
}

// features: null = todas as funcionalidades (plano completo).
const EXAMPLES = [
  { name: 'Só Disparos', description: 'Envio em massa por WhatsApp e e-mail', priceCents: 9700, cycleMonths: 1, maxWhatsappConnections: 2, maxMembers: 2, maxMonthlyMessages: 3000, sortOrder: 1, features: ['disparos'] },
  { name: 'Discador para Equipes', description: 'Para equipes de vendas que já ligam todos os dias', priceCents: 14700, cycleMonths: 1, maxWhatsappConnections: 1, maxMembers: 10, maxMonthlyMessages: null, sortOrder: 2, features: ['discador'] },
  { name: 'Atendimento + CRM', description: 'Chat de WhatsApp e funil de vendas', priceCents: 19700, cycleMonths: 1, maxWhatsappConnections: 3, maxMembers: 5, maxMonthlyMessages: null, sortOrder: 3, features: ['chat', 'crm'] },
  { name: 'Completo', description: 'Todas as funcionalidades do sistema', priceCents: 49700, cycleMonths: 1, maxWhatsappConnections: 10, maxMembers: null, maxMonthlyMessages: null, sortOrder: 4, features: null }
];

/** Marca também os módulos exigidos pelos escolhidos (ex.: Disparos exige Contatos e Conexões). */
function withDependencies(keys, catalog) {
  const byKey = Object.fromEntries(catalog.map((f) => [f.key, f]));
  const result = new Set(keys);
  const queue = [...keys];
  while (queue.length) {
    const key = queue.pop();
    (byKey[key]?.requires || []).forEach((dep) => {
      if (!result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    });
  }
  return result;
}

function FeatureChips({ features, catalog }) {
  if (!Array.isArray(features)) return <span className="adm-badge adm-ativa">Completo</span>;
  return (
    <div className="adm-chips">
      {catalog.filter((f) => features.includes(f.key)).map((f) => (
        <span key={f.key} className="adm-chip" title={f.label}>{f.icon} {f.label.split(' (')[0]}</span>
      ))}
    </div>
  );
}

function PlanForm({ plan, catalog, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: plan?.name || '',
    description: plan?.description || '',
    price: plan ? (plan.priceCents / 100).toFixed(2).replace('.', ',') : '',
    cycleMonths: plan?.cycleMonths || 1,
    maxWhatsappConnections: plan?.maxWhatsappConnections ?? '',
    maxMembers: plan?.maxMembers ?? '',
    maxMonthlyMessages: plan?.maxMonthlyMessages ?? '',
    isPublic: plan ? plan.isPublic : true,
    isActive: plan ? plan.isActive : true,
    sortOrder: plan?.sortOrder ?? 0
  });
  // Módulos: "todos" (plano completo) ou uma lista escolhida.
  const [allFeatures, setAllFeatures] = useState(!plan || !Array.isArray(plan.features));
  const [selected, setSelected] = useState(() => new Set(Array.isArray(plan?.features) ? plan.features : []));
  const [saving, setSaving] = useState(false);

  function toggleFeature(key) {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
      // Ao desmarcar, remove também quem dependia dele (ex.: tirar Contatos tira Disparos).
      let changed = true;
      while (changed) {
        changed = false;
        catalog.forEach((f) => {
          if (next.has(f.key) && f.requires.some((r) => !next.has(r))) {
            next.delete(f.key);
            changed = true;
          }
        });
      }
    } else {
      next.add(key);
    }
    setSelected(withDependencies([...next], catalog));
  }

  function applyPreset(keys) {
    if (keys === null) {
      setAllFeatures(true);
    } else {
      setAllFeatures(false);
      setSelected(withDependencies(keys, catalog));
    }
  }

  async function submit(e) {
    e.preventDefault();
    const priceCents = reaisToCents(form.price);
    if (Number.isNaN(priceCents) || priceCents < 0) return alert('Informe o preço em reais, por exemplo 197,00');
    if (!allFeatures && selected.size === 0) return alert('Marque pelo menos um módulo, ou escolha “Todas as funcionalidades”.');
    setSaving(true);
    try {
      const payload = {
        features: allFeatures ? null : [...selected],
        name: form.name,
        description: form.description,
        priceCents,
        cycleMonths: Number(form.cycleMonths),
        maxWhatsappConnections: form.maxWhatsappConnections,
        maxMembers: form.maxMembers,
        maxMonthlyMessages: form.maxMonthlyMessages,
        isPublic: form.isPublic,
        isActive: form.isActive,
        sortOrder: Number(form.sortOrder) || 0
      };
      if (plan) await api.patch(`/admin/plans/${plan.id}`, payload);
      else await api.post('/admin/plans', payload);
      onSaved();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao salvar o plano');
    } finally {
      setSaving(false);
    }
  }

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal adm-modal adm-modal-sm" onClick={(e) => e.stopPropagation()}>
        <h2>{plan ? 'Editar plano' : '➕ Novo plano'}</h2>
        <form onSubmit={submit} className="adm-stack">
          <input placeholder="Nome do plano (ex.: Profissional)" required value={form.name} onChange={set('name')} />
          <input placeholder="Descrição curta (opcional)" value={form.description} onChange={set('description')} />
          <div className="adm-form-grid">
            <div>
              <label className="adm-label">Preço (R$)</label>
              <input placeholder="197,00" required value={form.price} onChange={set('price')} inputMode="decimal" />
            </div>
            <div>
              <label className="adm-label">Cobrança</label>
              <select value={form.cycleMonths} onChange={set('cycleMonths')}>
                {Object.entries(CYCLE_LABEL).map(([months, label]) => (
                  <option key={months} value={months}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="adm-features">
            <label className="adm-label">O que este plano libera</label>
            <div className="adm-presets">
              <button type="button" className={`btn-outline ${allFeatures ? 'is-on' : ''}`} onClick={() => applyPreset(null)}>⭐ Todas as funcionalidades</button>
              <button type="button" className="btn-outline" onClick={() => applyPreset(['disparos'])}>📣 Só Disparos</button>
              <button type="button" className="btn-outline" onClick={() => applyPreset(['discador'])}>📞 Só Discador</button>
              <button type="button" className="btn-outline" onClick={() => applyPreset(['chat', 'crm'])}>💬 Chat + CRM</button>
            </div>
            {allFeatures ? (
              <p className="adm-muted">Plano completo: o cliente usa tudo, inclusive módulos novos que você criar no futuro.</p>
            ) : (
              <div className="adm-feature-list">
                {catalog.map((f) => {
                  const requiredByOther = catalog.some((o) => selected.has(o.key) && o.requires.includes(f.key));
                  return (
                    <label key={f.key} className={`adm-feature ${selected.has(f.key) ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(f.key)}
                        disabled={requiredByOther}
                        onChange={() => toggleFeature(f.key)}
                      />
                      <span>
                        <strong>{f.icon} {f.label}</strong>
                        <small>{f.description}{requiredByOther ? ' (necessário para outro módulo marcado)' : ''}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {allFeatures && (
              <button type="button" className="btn-outline" onClick={() => { setAllFeatures(false); setSelected(new Set()); }}>
                Escolher módulos um a um
              </button>
            )}
          </div>
          <p className="adm-muted">Limites — deixe VAZIO para “sem limite”.</p>
          <div className="adm-form-grid">
            <div>
              <label className="adm-label">Conexões de WhatsApp</label>
              <input type="number" min="0" placeholder="vazio = até 10" value={form.maxWhatsappConnections} onChange={set('maxWhatsappConnections')} />
            </div>
            <div>
              <label className="adm-label">Usuários</label>
              <input type="number" min="0" placeholder="vazio = ilimitado" value={form.maxMembers} onChange={set('maxMembers')} />
            </div>
            <div>
              <label className="adm-label">Mensagens de disparo por mês</label>
              <input type="number" min="0" placeholder="vazio = ilimitado" value={form.maxMonthlyMessages} onChange={set('maxMonthlyMessages')} />
            </div>
            <div>
              <label className="adm-label">Ordem na vitrine</label>
              <input type="number" value={form.sortOrder} onChange={set('sortOrder')} />
            </div>
          </div>
          <label className="adm-check"><input type="checkbox" checked={form.isPublic} onChange={set('isPublic')} /> Aparece para o cliente escolher</label>
          <label className="adm-check"><input type="checkbox" checked={form.isActive} onChange={set('isActive')} /> Plano ativo</label>
          <div className="adm-row adm-right">
            <button type="button" className="btn-outline" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar plano'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PlansPanel() {
  const [plans, setPlans] = useState([]);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(undefined); // undefined = fechado, null = novo, objeto = editar

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/plans');
      setPlans(data.plans);
      setBillingEnabled(data.billingEnabled);
      setCatalog(data.featureCatalog || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createExamples() {
    if (!window.confirm('Criar 4 planos de exemplo (Só Disparos, Discador para Equipes, Atendimento + CRM e Completo)? Você pode editar os valores depois.')) return;
    try {
      for (const plan of EXAMPLES) await api.post('/admin/plans', plan);
      load();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar os planos');
    }
  }

  async function remove(plan) {
    if (!window.confirm(`Remover o plano "${plan.name}"?`)) return;
    try {
      const { data } = await api.delete(`/admin/plans/${plan.id}`);
      if (data.message) alert(data.message);
      load();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao remover');
    }
  }

  return (
    <div>
      {!billingEnabled && (
        <div className="adm-note">
          💡 A <strong>cobrança automática</strong> está desligada (falta <code>ASAAS_API_KEY</code> no .env). Os planos já funcionam para definir <strong>limites</strong>; para o cliente pagar sozinho, siga o guia de cobrança.
        </div>
      )}
      <div className="adm-row adm-right" style={{ marginBottom: 12 }}>
        {plans.length === 0 && !loading && <button className="btn-outline" onClick={createExamples}>✨ Criar planos de exemplo</button>}
        <button className="btn-primary" onClick={() => setEditing(null)}>➕ Novo plano</button>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Plano</th>
              <th>Preço</th>
              <th>Módulos</th>
              <th>WhatsApps</th>
              <th>Usuários</th>
              <th>Msgs/mês</th>
              <th>Clientes</th>
              <th>Situação</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td data-label="Plano"><strong>{p.name}</strong><div className="adm-muted">{p.description}</div></td>
                <td data-label="Preço">{money(p.priceCents)} <span className="adm-muted">/ {CYCLE_LABEL[p.cycleMonths]?.toLowerCase()}</span></td>
                <td data-label="Módulos"><FeatureChips features={p.features} catalog={catalog} /></td>
                <td data-label="WhatsApps">{p.maxWhatsappConnections ?? 'até 10'}</td>
                <td data-label="Usuários">{p.maxMembers ?? '∞'}</td>
                <td data-label="Msgs/mês">{p.maxMonthlyMessages !== null ? p.maxMonthlyMessages.toLocaleString('pt-BR') : '∞'}</td>
                <td data-label="Clientes">{p._count?.accounts ?? 0}</td>
                <td data-label="Situação">
                  <span className={`adm-badge ${p.isActive ? 'adm-ativa' : 'adm-bloqueada'}`}>{p.isActive ? 'Ativo' : 'Inativo'}</span>
                  {!p.isPublic && <div className="adm-muted">oculto ao cliente</div>}
                </td>
                <td data-label="Ações" className="admin-actions">
                  <button className="btn-outline" onClick={() => setEditing(p)}>Editar</button>
                  <button className="btn-outline" onClick={() => remove(p)}>Remover</button>
                </td>
              </tr>
            ))}
            {!loading && plans.length === 0 && (
              <tr><td colSpan={9} className="empty-state">Nenhum plano ainda. Crie o primeiro (ou use os exemplos).</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <PlanForm
          plan={editing}
          catalog={catalog}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
    </div>
  );
}
