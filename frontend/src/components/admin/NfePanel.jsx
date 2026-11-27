// frontend/src/components/admin/NfePanel.jsx
//
// Administrador: planos EXCLUSIVOS do emissor de NF-e (preço, ciclo, notas por mês) e assinaturas dos clientes.
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import '../account/Account.css';

const CYCLE_LABEL = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('pt-BR') : 'Sem vencimento');

function reaisToCents(text) {
  const clean = String(text).trim().replace(/[^\d.,]/g, '');
  if (!clean) return NaN;
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  return Math.round(parseFloat(normalized) * 100);
}

const EMPTY_ADDON = { id: null, kind: 'storage', name: '', description: '', amount: '', price: '', validMonths: 12, isActive: true, sortOrder: 0 };
const EMPTY = { id: null, name: '', description: '', price: '', cycleMonths: 1, maxMonthlyNotes: '', storageMb: '', isActive: true, isPublic: true, sortOrder: 0 };

export default function NfePanel() {
  const [plans, setPlans] = useState([]);
  const [subs, setSubs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [addons, setAddons] = useState([]);
  const [aform, setAform] = useState(null);
  const [msg, setMsg] = useState(null);
  const [grant, setGrant] = useState({ accountId: '', planId: '', months: '1', endsAt: '', forever: false });

  const load = useCallback(async () => {
    try {
      const [p, s, ad] = await Promise.all([api.get('/admin/nfe/plans'), api.get('/admin/nfe/subscriptions'), api.get('/admin/nfe/addons')]);
      setAddons(ad.data.addons || []);
      setPlans(p.data.plans);
      setSubs(s.data.items);
    } catch (e) {
      setMsg({ error: true, text: e.response?.data?.error || 'Erro ao carregar.' });
    }
  }, []);

  useEffect(() => {
    load();
    api.get('/admin/accounts').then((r) => setAccounts(r.data.accounts || [])).catch(() => {});
  }, [load]);

  function edit(plan) {
    setForm(plan ? {
      id: plan.id, name: plan.name, description: plan.description || '', price: (plan.priceCents / 100).toFixed(2).replace('.', ','),
      cycleMonths: plan.cycleMonths, maxMonthlyNotes: plan.maxMonthlyNotes ?? '', storageMb: plan.storageMb ?? '', isActive: plan.isActive, isPublic: plan.isPublic, sortOrder: plan.sortOrder
    } : { ...EMPTY });
    setMsg(null);
  }

  async function save(e) {
    e.preventDefault();
    const priceCents = reaisToCents(form.price);
    if (Number.isNaN(priceCents)) return setMsg({ error: true, text: 'Informe o preço (ex.: 49,90).' });
    const body = {
      name: form.name, description: form.description, priceCents, cycleMonths: Number(form.cycleMonths),
      maxMonthlyNotes: form.maxMonthlyNotes === '' ? null : Number(form.maxMonthlyNotes),
      storageMb: form.storageMb === '' ? null : Number(form.storageMb),
      isActive: form.isActive, isPublic: form.isPublic, sortOrder: Number(form.sortOrder) || 0
    };
    try {
      if (form.id) await api.patch(`/admin/nfe/plans/${form.id}`, body);
      else await api.post('/admin/nfe/plans', body);
      setForm(null);
      setMsg({ text: 'Plano salvo.' });
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao salvar.' });
    }
  }

  async function remove(plan) {
    if (!window.confirm(`Apagar o plano "${plan.name}"? Se já houver assinantes ele só será desativado (quem tem continua).`)) return;
    try {
      const { data } = await api.delete(`/admin/nfe/plans/${plan.id}`);
      setMsg({ text: data.deactivated ? 'Plano desativado (tem assinantes).' : 'Plano apagado.' });
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao apagar.' });
    }
  }

  function editAddon(a) {
    setAform(a ? { id: a.id, kind: a.kind, name: a.name, description: a.description || '', amount: a.amount, price: (a.priceCents / 100).toFixed(2).replace('.', ','), validMonths: a.validMonths, isActive: a.isActive, sortOrder: a.sortOrder } : { ...EMPTY_ADDON });
    setMsg(null);
  }

  async function saveAddon(e) {
    e.preventDefault();
    const priceCents = reaisToCents(aform.price);
    if (Number.isNaN(priceCents)) return setMsg({ error: true, text: 'Informe o preço do pacote (ex.: 19,90).' });
    const body = { kind: aform.kind, name: aform.name, description: aform.description, amount: Number(aform.amount), priceCents, validMonths: Number(aform.validMonths) || 12, isActive: aform.isActive, sortOrder: Number(aform.sortOrder) || 0 };
    try {
      if (aform.id) await api.patch(`/admin/nfe/addons/${aform.id}`, body);
      else await api.post('/admin/nfe/addons', body);
      setAform(null);
      setMsg({ text: 'Pacote salvo.' });
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao salvar o pacote.' });
    }
  }

  async function removeAddon(a) {
    if (!window.confirm(`Apagar o pacote "${a.name}"? Se já foi vendido ele só some da vitrine (quem comprou mantém).`)) return;
    try {
      const { data } = await api.delete(`/admin/nfe/addons/${a.id}`);
      setMsg({ text: data.deactivated ? 'Pacote retirado da vitrine (já tem compras).' : 'Pacote apagado.' });
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao apagar.' });
    }
  }

  async function doGrant() {
    try {
      await api.post('/admin/nfe/subscriptions', {
        accountId: grant.accountId, planId: grant.planId || null, months: Number(grant.months) || 1,
        endsAt: grant.forever ? 'none' : grant.endsAt || undefined
      });
      setMsg({ text: 'NF-e liberada para a conta.' });
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao liberar.' });
    }
  }

  async function revoke(s) {
    if (!window.confirm(`Encerrar a NF-e de "${s.accountName}"? Ela passa para o modo consulta (só baixar notas).`)) return;
    try {
      await api.delete(`/admin/nfe/subscriptions/${s.accountId}`);
      load();
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao encerrar.' });
    }
  }

  return (
    <div>
      <div className="acc-card">
        <h3>🧾 Emissor de NF-e — planos exclusivos</h3>
        <p className="acc-muted">
          O emissor de notas é vendido por <strong>plano próprio</strong>, com cobrança separada do plano do Turbo Prospect (Asaas).
          Defina preço, ciclo e quantas notas <strong>de produção</strong> por mês cada plano inclui (vazio = ilimitado). Notas de
          homologação (teste) nunca contam. Vencido o plano, o cliente continua podendo consultar e baixar XML/DANFE, mas não emitir.
          Administradores da plataforma usam o emissor sem plano e sem limite.
        </p>
        {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
        <div className="acc-row"><button className="btn-primary" onClick={() => edit(null)}>➕ Novo plano de NF-e</button></div>

        {form && (
          <form onSubmit={save} className="acc-card" style={{ marginTop: 12 }}>
            <h4>{form.id ? 'Editar plano' : 'Novo plano'}</h4>
            <div className="acc-grid">
              <div><label htmlFor="nf-name">Nome</label><input id="nf-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: NF-e Básico" /></div>
              <div><label htmlFor="nf-price">Preço por ciclo (R$)</label><input id="nf-price" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="49,90" /></div>
              <div><label htmlFor="nf-cycle">Ciclo de cobrança</label>
                <select id="nf-cycle" value={form.cycleMonths} onChange={(e) => setForm({ ...form, cycleMonths: e.target.value })}>
                  {Object.entries(CYCLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div><label htmlFor="nf-max">Notas de produção por mês (vazio = ilimitado)</label><input id="nf-max" inputMode="numeric" value={form.maxMonthlyNotes} onChange={(e) => setForm({ ...form, maxMonthlyNotes: e.target.value.replace(/\D/g, '') })} placeholder="Ex.: 100" /></div>
              <div><label htmlFor="nf-mb">Espaço para guardar notas, em MB (vazio = espaço padrão)</label><input id="nf-mb" inputMode="numeric" value={form.storageMb} onChange={(e) => setForm({ ...form, storageMb: e.target.value.replace(/\D/g, '') })} placeholder="Ex.: 2000" /></div>
              <div><label htmlFor="nf-desc">Descrição (aparece para o cliente)</label><input id="nf-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div><label htmlFor="nf-sort">Ordem na vitrine</label><input id="nf-sort" inputMode="numeric" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} /></div>
            </div>
            <div className="acc-row">
              <label><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Ativo</label>
              <label><input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} /> Aparece para o cliente escolher</label>
            </div>
            <div className="acc-row"><button className="btn-primary" type="submit">Salvar</button> <button type="button" className="btn-outline" onClick={() => setForm(null)}>Cancelar</button></div>
          </form>
        )}
      </div>

      <div className="acc-card">
        <h3>Planos de NF-e ({plans.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Plano</th><th>Preço</th><th>Ciclo</th><th>Notas/mês</th><th>Espaço</th><th>Assinantes</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><br /><span className="acc-muted">{p.description}</span></td>
                  <td>{money(p.priceCents)}</td><td>{CYCLE_LABEL[p.cycleMonths]}</td>
                  <td>{p.maxMonthlyNotes ?? 'Ilimitado'}</td><td>{p.storageMb ? `${p.storageMb} MB` : 'Padrão'}</td><td>{p._count?.subscriptions ?? 0}</td>
                  <td>{p.isActive ? (p.isPublic ? 'Ativo' : 'Ativo (oculto)') : 'Desativado'}</td>
                  <td><button className="btn-outline" onClick={() => edit(p)}>Editar</button> <button className="btn-outline" onClick={() => remove(p)}>Apagar</button></td>
                </tr>
              ))}
              {plans.length === 0 && <tr><td colSpan={8} className="acc-muted">Nenhum plano ainda. Crie o primeiro acima.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="acc-card">
        <h3>📦 Pacotes avulsos de NF-e ({addons.length})</h3>
        <p className="acc-muted">
          Vendidos dentro do aplicativo, em Notas Fiscais &gt; Comprar notas ou espaço, para quem tem plano de NF-e ou plano completo com NF-e.
          <strong> Notas extras</strong> valem só no mês do pagamento. <strong>Espaço (MB)</strong> vale pelos meses informados (padrão 12) e
          soma ao espaço do plano. Sem espaço, o cliente fica sem emitir, mas sempre pode baixar o backup.
        </p>
        <div className="acc-row"><button className="btn-primary" onClick={() => editAddon(null)}>➕ Novo pacote</button></div>
        {aform && (
          <form onSubmit={saveAddon} className="acc-card" style={{ marginTop: 12 }}>
            <div className="acc-grid">
              <div><label htmlFor="ad-kind">Tipo</label>
                <select id="ad-kind" value={aform.kind} onChange={(e) => setAform({ ...aform, kind: e.target.value })}><option value="storage">Espaço (MB)</option><option value="notes">Notas extras no mês</option></select></div>
              <div><label htmlFor="ad-name">Nome</label><input id="ad-name" required value={aform.name} onChange={(e) => setAform({ ...aform, name: e.target.value })} placeholder="Ex.: +100 MB de espaço" /></div>
              <div><label htmlFor="ad-amount">{aform.kind === 'notes' ? 'Quantidade de notas' : 'Megabytes'}</label><input id="ad-amount" required inputMode="numeric" value={aform.amount} onChange={(e) => setAform({ ...aform, amount: e.target.value.replace(/\D/g, '') })} /></div>
              <div><label htmlFor="ad-price">Preço (R$)</label><input id="ad-price" required value={aform.price} onChange={(e) => setAform({ ...aform, price: e.target.value })} placeholder="19,90" /></div>
              {aform.kind === 'storage' && <div><label htmlFor="ad-valid">Validade (meses)</label><input id="ad-valid" inputMode="numeric" value={aform.validMonths} onChange={(e) => setAform({ ...aform, validMonths: e.target.value.replace(/\D/g, '') })} /></div>}
              <div><label htmlFor="ad-desc">Descrição</label><input id="ad-desc" value={aform.description} onChange={(e) => setAform({ ...aform, description: e.target.value })} /></div>
            </div>
            <div className="acc-row"><label><input type="checkbox" checked={aform.isActive} onChange={(e) => setAform({ ...aform, isActive: e.target.checked })} /> Ativo (aparece para venda)</label></div>
            <div className="acc-row"><button className="btn-primary" type="submit">Salvar pacote</button> <button type="button" className="btn-outline" onClick={() => setAform(null)}>Cancelar</button></div>
          </form>
        )}
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Pacote</th><th>Tipo</th><th>Quantidade</th><th>Preço</th><th>Validade</th><th>Vendas</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {addons.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong><br /><span className="acc-muted">{a.description}</span></td>
                  <td>{a.kind === 'notes' ? 'Notas' : 'Espaço'}</td>
                  <td>{a.amount.toLocaleString('pt-BR')} {a.kind === 'notes' ? 'notas' : 'MB'}</td>
                  <td>{money(a.priceCents)}</td>
                  <td>{a.kind === 'notes' ? 'Mês do pagamento' : `${a.validMonths} mês(es)`}</td>
                  <td>{a._count?.purchases ?? 0}</td><td>{a.isActive ? 'Ativo' : 'Desativado'}</td>
                  <td><button className="btn-outline" onClick={() => editAddon(a)}>Editar</button> <button className="btn-outline" onClick={() => removeAddon(a)}>Apagar</button></td>
                </tr>
              ))}
              {addons.length === 0 && <tr><td colSpan={8} className="acc-muted">Nenhum pacote ainda. Sugestão: +100 MB, +200 MB, +500 MB de espaço e +100/+500 notas.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="acc-card">
        <h3>Liberar / renovar NF-e manualmente</h3>
        <p className="acc-muted">Para cortesia, teste grátis, pagamento fora do sistema ou cliente que paga por fora. Soma meses ao vencimento atual, ou define uma data, ou deixa sem vencimento.</p>
        <div className="acc-grid">
          <div><label htmlFor="gr-acc">Conta</label>
            <select id="gr-acc" value={grant.accountId} onChange={(e) => setGrant({ ...grant, accountId: e.target.value })}><option value="">Escolha…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div><label htmlFor="gr-plan">Plano de NF-e</label>
            <select id="gr-plan" value={grant.planId} onChange={(e) => setGrant({ ...grant, planId: e.target.value })}><option value="">(manter o atual)</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div><label htmlFor="gr-m">Somar meses</label><input id="gr-m" inputMode="numeric" value={grant.months} onChange={(e) => setGrant({ ...grant, months: e.target.value })} disabled={grant.forever || Boolean(grant.endsAt)} /></div>
          <div><label htmlFor="gr-d">…ou vencer em</label><input id="gr-d" type="date" value={grant.endsAt} onChange={(e) => setGrant({ ...grant, endsAt: e.target.value })} disabled={grant.forever} /></div>
        </div>
        <div className="acc-row">
          <label><input type="checkbox" checked={grant.forever} onChange={(e) => setGrant({ ...grant, forever: e.target.checked })} /> Sem vencimento (cortesia)</label>
          <button className="btn-primary" disabled={!grant.accountId} onClick={doGrant}>Liberar</button>
        </div>
      </div>

      <div className="acc-card">
        <h3>Assinaturas de NF-e ({subs.length})</h3>
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead><tr><th>Conta</th><th>Plano</th><th>Vence</th><th>Situação</th><th>Cobrança</th><th /></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.accountName}</td><td>{s.plan?.name || '—'}</td><td>{fmtDate(s.endsAt)}</td>
                  <td>{s.status === 'ativa' ? 'Ativa' : 'Vencida (só consulta)'}</td>
                  <td>{s.recurring ? 'Recorrente (Asaas)' : 'Manual'}</td>
                  <td><button className="btn-outline" onClick={() => revoke(s)}>Encerrar</button></td>
                </tr>
              ))}
              {subs.length === 0 && <tr><td colSpan={6} className="acc-muted">Nenhuma assinatura ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
