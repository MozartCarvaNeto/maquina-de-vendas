// frontend/src/pages/Admin.jsx
//
// Painel do ADMINISTRADOR DA PLATAFORMA: aprova cadastros, controla o prazo
// de cada assinatura, bloqueia/desbloqueia clientes. Só abre para quem tem o
// e-mail listado em SUPERADMIN_EMAILS no backend/.env.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import PlansPanel from '../components/admin/PlansPanel';
import './Admin.css';

const STATUS_LABEL = { pendente: 'Pendente', ativa: 'Ativa', expirada: 'Vencida', bloqueada: 'Bloqueada' };

const FILTERS = [
  ['todas', 'Todas'],
  ['pendente', 'Pendentes'],
  ['ativa', 'Ativas'],
  ['expirando', 'Vencem em 7 dias'],
  ['expirada', 'Vencidas'],
  ['bloqueada', 'Bloqueadas']
];

const ACTION_LABEL = {
  cadastro: '📝 Cadastro',
  criada: '➕ Conta criada',
  aprovada: '✅ Aprovada',
  renovada: '🔄 Renovada',
  bloqueada: '⛔ Bloqueada',
  desbloqueada: '🔓 Desbloqueada',
  editada: '✏️ Editada',
  senha_redefinida: '🔑 Senha redefinida',
  pagamento: '💰 Pagamento',
  cobranca: '🧾 Cobrança',
  plano: '💼 Plano',
  estorno: '↩️ Estorno / chargeback'
};

function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString('pt-BR') : '—';
}

function fmtDateTime(value) {
  return value ? new Date(value).toLocaleString('pt-BR') : 'Nunca';
}

// Data como "AAAA-MM-DD" no horário de Brasília (formato do <input type="date">).
function toInputDate(value) {
  return value ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : '';
}

function remainingText(account) {
  if (account.status === 'pendente') return 'Aguardando aprovação';
  if (!account.endsAt) return 'Sem vencimento';
  const n = account.daysLeft;
  if (account.status === 'expirada') return n < 0 ? `Venceu há ${-n} dia${-n === 1 ? '' : 's'}` : 'Venceu hoje';
  if (n <= 0) return 'Vence hoje';
  return `${n} dia${n === 1 ? '' : 's'}`;
}

function remainingTone(account) {
  if (account.status === 'expirada' || account.status === 'bloqueada') return 'danger';
  if (account.status === 'ativa' && account.endsAt && account.daysLeft <= 7) return 'warn';
  return '';
}

function errorMessage(error, fallback) {
  return error.response?.data?.error || fallback;
}

function StatusBadge({ status }) {
  return <span className={`adm-badge adm-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

// ---------------------------------------------------------------------------
// Modal: detalhes e controle de UMA conta
// ---------------------------------------------------------------------------
function AccountModal({ accountId, onClose, onChanged, onCredentials }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [customDays, setCustomDays] = useState('');
  const [approveDays, setApproveDays] = useState('30');
  const [blockReason, setBlockReason] = useState('');
  const [allPlans, setAllPlans] = useState([]);
  const [planSel, setPlanSel] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [payLink, setPayLink] = useState('');
  // Guarda o onClose mais recente sem fazer o efeito abaixo rodar de novo
  // (senão qualquer atualização da página recarregaria os dados e apagaria o que você está digitando).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    const { data: res } = await api.get(`/admin/accounts/${accountId}`);
    setData(res);
    setPlanSel(res.account.planId || '');
    setForm({
      name: res.account.name,
      plan: res.account.plan || '',
      startsAt: toInputDate(res.account.startsAt),
      endsAt: toInputDate(res.account.endsAt),
      noEnd: !res.account.endsAt,
      adminNotes: res.account.adminNotes || ''
    });
  }, [accountId]);

  useEffect(() => {
    api.get('/admin/plans').then(({ data: res }) => setAllPlans(res.plans)).catch(() => {});
  }, []);

  useEffect(() => {
    load().catch((e) => {
      alert(errorMessage(e, 'Erro ao carregar a conta'));
      onCloseRef.current();
    });
  }, [load]);

  async function run(fn, successReload = true) {
    setBusy(true);
    try {
      await fn();
      if (successReload) {
        await load();
        onChanged();
      }
    } catch (e) {
      alert(errorMessage(e, 'Não foi possível concluir a ação'));
    } finally {
      setBusy(false);
    }
  }

  if (!data || !form) {
    return (
      <div className="modal-overlay">
        <div className="modal adm-modal">Carregando...</div>
      </div>
    );
  }

  const { account, members, logs, usage, limits, payments = [], billingEnabled, pendingPayment } = data;
  const shownLink = payLink || pendingPayment?.url || '';
  const locked = account.isPlatformAdminAccount;

  const save = () =>
    run(() =>
      api.patch(`/admin/accounts/${account.id}`, {
        name: form.name,
        plan: form.plan,
        adminNotes: form.adminNotes,
        startsAt: form.startsAt || null,
        endsAt: form.noEnd ? null : form.endsAt || null
      })
    );

  const extend = (days) => {
    if (!days || Number(days) < 1) return alert('Informe a quantidade de dias.');
    return run(() => api.post(`/admin/accounts/${account.id}/extend`, { days: Number(days) }));
  };

  const approve = () =>
    run(() =>
      api.post(`/admin/accounts/${account.id}/approve`, approveDays === 'sem' ? { unlimited: true } : { days: Number(approveDays) })
    );

  const block = () => {
    if (!window.confirm(`Bloquear "${account.name}"? Ninguém dessa empresa conseguirá entrar e o WhatsApp dela será desligado.`)) return;
    return run(() => api.post(`/admin/accounts/${account.id}/block`, { reason: blockReason }));
  };

  const unblock = () => run(() => api.post(`/admin/accounts/${account.id}/unblock`));

  const assignPlan = () => run(() => api.post(`/admin/accounts/${account.id}/plan`, { planId: planSel || null }));

  const charge = () =>
    run(async () => {
      const { data: res } = await api.post(`/admin/accounts/${account.id}/charge`, { planId: planSel || undefined, cpfCnpj });
      setPayLink(res.payUrl || '');
      if (!res.payUrl) alert('Assinatura criada, mas o link de pagamento ainda não ficou disponível. Reabra esta conta em instantes.');
    });

  const cancelBilling = () => {
    if (!window.confirm('Cancelar a cobrança recorrente? O cliente mantém o acesso até o vencimento atual.')) return;
    return run(() => api.post(`/admin/accounts/${account.id}/cancel-billing`));
  };

  const resetPassword = async () => {
    if (!window.confirm(`Gerar uma nova senha temporária para ${account.owner?.email}?`)) return;
    setBusy(true);
    try {
      const { data: res } = await api.post(`/admin/accounts/${account.id}/reset-password`, {});
      onCredentials(res.credentials);
      await load();
    } catch (e) {
      alert(errorMessage(e, 'Erro ao redefinir a senha'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal adm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-head">
          <div>
            <h2>{account.name}</h2>
            <StatusBadge status={account.status} />
            {account.inGrace && <span className="adm-grace"> em tolerância</span>}
          </div>
          <button className="adm-close" onClick={onClose} aria-label="Fechar">×</button>
        </div>

        <div className="adm-info-grid">
          <div><span>Responsável</span><strong>{account.owner?.name || '—'}</strong></div>
          <div><span>E-mail de login</span><strong>{account.owner?.email || '—'}</strong></div>
          <div><span>Usuários na conta</span><strong>{account.memberCount}</strong></div>
          <div><span>Cadastrada em</span><strong>{fmtDate(account.createdAt)}</strong></div>
          <div><span>Último acesso</span><strong>{fmtDateTime(account.lastLoginAt)}</strong></div>
          <div><span>WhatsApps / Leads</span><strong>{account.counts?.whatsapp ?? 0} / {account.counts?.leads ?? 0}</strong></div>
        </div>

        {account.status === 'bloqueada' && account.blockedReason && (
          <div className="adm-alert">⛔ Motivo do bloqueio: {account.blockedReason}</div>
        )}

        {locked && <div className="adm-note">Esta é a conta do administrador da plataforma: ela nunca é bloqueada nem vence.</div>}

        {/* ---------- Aprovar (somente pendente) ---------- */}
        {account.status === 'pendente' && (
          <section className="adm-section adm-highlight">
            <h3>✅ Aprovar este cadastro</h3>
            <p>Escolha por quanto tempo o acesso vale a partir de hoje.</p>
            <div className="adm-row">
              <select value={approveDays} onChange={(e) => setApproveDays(e.target.value)}>
                <option value="7">7 dias (teste)</option>
                <option value="30">30 dias</option>
                <option value="90">90 dias</option>
                <option value="180">180 dias</option>
                <option value="365">365 dias</option>
                <option value="sem">Sem vencimento</option>
              </select>
              <button className="btn-primary" disabled={busy} onClick={approve}>Aprovar e liberar acesso</button>
            </div>
          </section>
        )}

        {/* ---------- Assinatura ---------- */}
        {!locked && (
          <section className="adm-section">
            <h3>📅 Assinatura</h3>
            <div className="adm-sub-summary">
              <div><span>Início</span><strong>{fmtDate(account.startsAt)}</strong></div>
              <div><span>Vencimento</span><strong>{account.endsAt ? fmtDate(account.endsAt) : 'Sem vencimento'}</strong></div>
              <div><span>Tempo restante</span><strong className={`adm-tone-${remainingTone(account)}`}>{remainingText(account)}</strong></div>
            </div>

            {account.status !== 'pendente' && (
              <>
                <label className="adm-label">Renovar (soma dias ao vencimento atual, ou a partir de hoje se já venceu)</label>
                <div className="adm-chips">
                  {[7, 30, 90, 180, 365].map((d) => (
                    <button key={d} className="btn-outline" disabled={busy} onClick={() => extend(d)}>+{d} dias</button>
                  ))}
                </div>
                <div className="adm-row">
                  <input type="number" min="1" placeholder="Outra quantidade de dias" value={customDays} onChange={(e) => setCustomDays(e.target.value)} />
                  <button className="btn-outline" disabled={busy} onClick={() => extend(customDays)}>Somar dias</button>
                </div>
              </>
            )}

            <div className="adm-form-grid">
              <div>
                <label className="adm-label">Plano</label>
                <input value={form.plan} placeholder="Ex.: Mensal, Anual, Teste" onChange={(e) => setForm({ ...form, plan: e.target.value })} />
              </div>
              <div>
                <label className="adm-label">Início</label>
                <input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
              </div>
              <div>
                <label className="adm-label">Vencimento (acesso vale até o fim deste dia)</label>
                <input type="date" value={form.endsAt} disabled={form.noEnd} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
                <label className="adm-check">
                  <input type="checkbox" checked={form.noEnd} onChange={(e) => setForm({ ...form, noEnd: e.target.checked })} />
                  Sem vencimento
                </label>
              </div>
              <div>
                <label className="adm-label">Nome da empresa</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
            </div>
          </section>
        )}

        <section className="adm-section">
          <h3>📝 Observações internas</h3>
          <textarea rows="3" placeholder="Só você vê isto (ex.: forma de pagamento, contato, combinados)" value={form.adminNotes} onChange={(e) => setForm({ ...form, adminNotes: e.target.value })} />
          <div className="adm-row adm-right">
            <button className="btn-primary" disabled={busy} onClick={save}>Salvar alterações</button>
          </div>
        </section>

        {/* ---------- Plano e cobrança ---------- */}
        {!locked && (
          <section className="adm-section">
            <h3>💼 Plano e cobrança</h3>
            <label className="adm-label">Plano (define os LIMITES de uso desta empresa)</label>
            <div className="adm-row">
              <select value={planSel} onChange={(e) => setPlanSel(e.target.value)}>
                <option value="">Sem plano (sem limites)</option>
                {allPlans.filter((p) => p.isActive || p.id === account.planId).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {(p.priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</option>
                ))}
              </select>
              <button className="btn-outline" disabled={busy || planSel === (account.planId || '')} onClick={assignPlan}>Definir plano</button>
            </div>

            {usage && (
              <ul className="adm-list adm-usage">
                <li>📱 WhatsApps: <strong>{usage.connections}</strong> / {limits?.maxWhatsappConnections ?? 'até 10'}</li>
                <li>👥 Usuários: <strong>{usage.members}</strong> / {limits?.maxMembers ?? '∞'}</li>
                <li>📣 Mensagens em {usage.period}: <strong>{usage.messages}</strong> / {limits?.maxMonthlyMessages ?? '∞'}</li>
              </ul>
            )}

            {billingEnabled ? (
              <>
                <label className="adm-label">Cobrança automática (Asaas) — CPF ou CNPJ do cliente</label>
                <div className="adm-row">
                  <input placeholder="Somente números" inputMode="numeric" value={cpfCnpj} onChange={(e) => setCpfCnpj(e.target.value)} />
                  <button className="btn-primary" disabled={busy || !planSel} onClick={charge}>💳 Gerar cobrança recorrente</button>
                </div>
                {!planSel && <p className="adm-muted">Escolha e defina um plano antes de gerar a cobrança.</p>}
                {account.billing?.hasSubscription && (
                  <div className="adm-row">
                    <span className="adm-muted">✅ Há uma assinatura recorrente ativa para esta conta.</span>
                    <button className="btn-outline" disabled={busy} onClick={cancelBilling}>Cancelar recorrência</button>
                  </div>
                )}
                {shownLink && (
                  <div className="adm-credentials">
                    <div><strong>Link de pagamento:</strong></div>
                    <a href={shownLink} target="_blank" rel="noopener noreferrer">{shownLink}</a>
                    <button className="btn-outline" onClick={() => navigator.clipboard?.writeText(shownLink)}>📋 Copiar link</button>
                  </div>
                )}
              </>
            ) : (
              <p className="adm-muted">Cobrança automática desligada. Para ativar, configure <code>ASAAS_API_KEY</code> no .env do servidor (veja o guia).</p>
            )}

            {payments.length > 0 && (
              <>
                <label className="adm-label">Pagamentos recebidos</label>
                <ul className="adm-list">
                  {payments.map((p) => (
                    <li key={p.id}>
                      {fmtDate(p.paidAt)} — <strong>{(p.amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong>
                      {p.invoiceUrl && <> · <a href={p.invoiceUrl} target="_blank" rel="noopener noreferrer">comprovante</a></>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {/* ---------- Bloqueio e senha ---------- */}
        {!locked && (
          <section className="adm-section">
            <h3>🔒 Acesso</h3>
            {account.accessStatus === 'bloqueada' ? (
              <div className="adm-row">
                <button className="btn-primary" disabled={busy} onClick={unblock}>🔓 Desbloquear conta</button>
              </div>
            ) : (
              <div className="adm-row">
                <input placeholder="Motivo do bloqueio (opcional)" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
                <button className="btn-danger" disabled={busy} onClick={block}>⛔ Bloquear</button>
              </div>
            )}
            <div className="adm-row">
              <button className="btn-outline" disabled={busy} onClick={resetPassword}>🔑 Gerar nova senha para o responsável</button>
            </div>
          </section>
        )}

        <section className="adm-section">
          <h3>👥 Usuários da conta</h3>
          <ul className="adm-list">
            {members.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong> — {m.email} <em>({m.role}{m.status !== 'ativo' ? ', desativado' : ''})</em>
              </li>
            ))}
          </ul>
        </section>

        <section className="adm-section">
          <h3>🕘 Histórico</h3>
          {logs.length === 0 && <p className="adm-muted">Nada registrado ainda.</p>}
          <ul className="adm-list adm-history">
            {logs.map((l) => (
              <li key={l.id}>
                <span className="adm-muted">{fmtDateTime(l.createdAt)}</span>
                <strong>{ACTION_LABEL[l.action] || l.action}</strong>
                {l.detail && <span> — {l.detail}</span>}
                {l.byEmail && <span className="adm-muted"> (por {l.byEmail})</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal: cadastrar um cliente manualmente
// ---------------------------------------------------------------------------
function CreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ companyName: '', ownerName: '', email: '', password: '', plan: '', days: '30', adminNotes: '' });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, days: form.days === 'sem' ? undefined : Number(form.days) };
      const { data } = await api.post('/admin/accounts', payload);
      onCreated(data.credentials);
    } catch (error) {
      alert(errorMessage(error, 'Erro ao criar a conta'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal adm-modal adm-modal-sm" onClick={(e) => e.stopPropagation()}>
        <h2>➕ Nova conta de cliente</h2>
        <p className="adm-muted">Use quando a venda já foi fechada: você cadastra e entrega o login ao cliente.</p>
        <form onSubmit={submit} className="adm-stack">
          <input placeholder="Nome da empresa" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
          <input placeholder="Nome do responsável" required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
          <input type="email" placeholder="E-mail de login" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="Senha (deixe vazio para gerar automaticamente)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input placeholder="Plano (ex.: Mensal)" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
          <select value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
            <option value="7">Vale por 7 dias (teste)</option>
            <option value="30">Vale por 30 dias</option>
            <option value="90">Vale por 90 dias</option>
            <option value="180">Vale por 180 dias</option>
            <option value="365">Vale por 365 dias</option>
            <option value="sem">Sem vencimento</option>
          </select>
          <textarea rows="2" placeholder="Observações internas (opcional)" value={form.adminNotes} onChange={(e) => setForm({ ...form, adminNotes: e.target.value })} />
          <div className="adm-row adm-right">
            <button type="button" className="btn-outline" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Criar conta'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function Admin() {
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [filter, setFilter] = useState('todas');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [tab, setTab] = useState('clientes');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/accounts', { params: { status: filter, q: debouncedSearch || undefined } })
      ]);
      setStats(overview.data.stats);
      setAccounts(list.data.accounts);
    } catch (error) {
      alert(errorMessage(error, 'Erro ao carregar o painel'));
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  async function quickAction(account, kind) {
    const messages = {
      approve: `Aprovar "${account.name}" por 30 dias?`,
      extend: `Renovar "${account.name}" por +30 dias?`,
      unblock: `Desbloquear "${account.name}"?`
    };
    if (!window.confirm(messages[kind])) return;
    setBusyId(account.id);
    try {
      if (kind === 'approve') await api.post(`/admin/accounts/${account.id}/approve`, { days: 30 });
      if (kind === 'extend') await api.post(`/admin/accounts/${account.id}/extend`, { days: 30 });
      if (kind === 'unblock') await api.post(`/admin/accounts/${account.id}/unblock`);
      await load();
    } catch (error) {
      alert(errorMessage(error, 'Não foi possível concluir a ação'));
    } finally {
      setBusyId(null);
    }
  }

  const statCards = stats
    ? [
        { key: 'pendente', label: 'Aguardando aprovação', value: stats.pendente, tone: stats.pendente > 0 ? 'attention' : '', filter: 'pendente' },
        { key: 'ativa', label: 'Ativas', value: stats.ativa, tone: 'ok', filter: 'ativa' },
        { key: 'expirando', label: 'Vencem em 7 dias', value: stats.expirando, tone: stats.expirando > 0 ? 'warn' : '', filter: 'expirando' },
        { key: 'expirada', label: 'Vencidas', value: stats.expirada, tone: stats.expirada > 0 ? 'danger' : '', filter: 'expirada' },
        { key: 'bloqueada', label: 'Bloqueadas', value: stats.bloqueada, tone: '', filter: 'bloqueada' },
        { key: 'total', label: 'Total de clientes', value: stats.total, tone: '', filter: 'todas' }
      ]
    : [];

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div>
          <h1>🛡️ Administração</h1>
          <p>Controle quem pode usar o sistema, aprove novos cadastros e acompanhe o prazo de cada assinatura. Contas vencidas são bloqueadas automaticamente.</p>
        </div>
        {tab === 'clientes' && <button className="btn-primary" onClick={() => setShowCreate(true)}>➕ Nova conta</button>}
      </header>

      <div className="admin-tabs">
        <button className={tab === 'clientes' ? 'is-active' : ''} onClick={() => setTab('clientes')}>👥 Clientes</button>
        <button className={tab === 'planos' ? 'is-active' : ''} onClick={() => setTab('planos')}>💼 Planos e preços</button>
      </div>

      {tab === 'planos' && <PlansPanel />}

      {tab === 'clientes' && (
        <>

      <div className="admin-stats">
        {statCards.map((card) => (
          <button key={card.key} className={`admin-stat ${card.tone ? `tone-${card.tone}` : ''} ${filter === card.filter ? 'is-active' : ''}`} onClick={() => setFilter(card.filter)}>
            <strong>{card.value}</strong>
            <span>{card.label}</span>
          </button>
        ))}
      </div>

      <div className="admin-toolbar">
        <div className="admin-filters">
          {FILTERS.map(([value, label]) => (
            <button key={value} className={filter === value ? 'btn-primary' : 'btn-outline'} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <input className="admin-search" placeholder="🔎 Buscar por empresa, nome ou e-mail" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Responsável</th>
              <th>Plano</th>
              <th>Situação</th>
              <th>Vencimento</th>
              <th>Tempo restante</th>
              <th>Último acesso</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td data-label="Empresa">
                  <strong>{a.name}</strong>
                  {a.isPlatformAdminAccount && <span className="adm-grace"> (você)</span>}
                </td>
                <td data-label="Responsável">
                  {a.owner?.name}
                  <div className="adm-muted">{a.owner?.email}</div>
                </td>
                <td data-label="Plano">{a.plan || '—'}</td>
                <td data-label="Situação"><StatusBadge status={a.status} /></td>
                <td data-label="Vencimento">{a.isPlatformAdminAccount ? '—' : a.endsAt ? fmtDate(a.endsAt) : a.status === 'pendente' ? '—' : 'Sem vencimento'}</td>
                <td data-label="Tempo restante" className={`adm-tone-${remainingTone(a)}`}>{a.isPlatformAdminAccount ? '—' : remainingText(a)}</td>
                <td data-label="Último acesso">{fmtDateTime(a.lastLoginAt)}</td>
                <td data-label="Ações" className="admin-actions">
                  {a.status === 'pendente' && (
                    <button className="btn-primary" disabled={busyId === a.id} onClick={() => quickAction(a, 'approve')}>✅ Aprovar 30d</button>
                  )}
                  {a.status === 'bloqueada' && (
                    <button className="btn-primary" disabled={busyId === a.id} onClick={() => quickAction(a, 'unblock')}>🔓 Desbloquear</button>
                  )}
                  {(a.status === 'expirada' || (a.status === 'ativa' && !a.isPlatformAdminAccount && a.endsAt)) && (
                    <button className={a.status === 'expirada' || (a.daysLeft !== null && a.daysLeft <= 7) ? 'btn-primary' : 'btn-outline'} disabled={busyId === a.id} onClick={() => quickAction(a, 'extend')}>
                      🔄 +30 dias
                    </button>
                  )}
                  <button className="btn-outline" onClick={() => setSelectedId(a.id)}>Detalhes</button>
                </td>
              </tr>
            ))}
            {!loading && accounts.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-state">Nenhuma conta encontrada neste filtro.</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={8} className="empty-state">Carregando...</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

        </>
      )}

      {selectedId && (
        <AccountModal accountId={selectedId} onClose={() => setSelectedId(null)} onChanged={load} onCredentials={setCredentials} />
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(creds) => {
            setShowCreate(false);
            setCredentials(creds);
            load();
          }}
        />
      )}

      {credentials && (
        <div className="modal-overlay" onClick={() => setCredentials(null)}>
          <div className="modal adm-modal-sm" onClick={(e) => e.stopPropagation()}>
            <h2>🔑 Dados de acesso</h2>
            <p className="adm-muted">Envie ao cliente por um canal seguro. A senha não será mostrada de novo.</p>
            <div className="adm-credentials">
              <div><strong>E-mail:</strong> {credentials.email}</div>
              <div><strong>Senha:</strong> {credentials.password}</div>
            </div>
            <div className="adm-row adm-right">
              <button
                className="btn-outline"
                onClick={() => navigator.clipboard?.writeText(`E-mail: ${credentials.email}\nSenha: ${credentials.password}`)}
              >
                📋 Copiar
              </button>
              <button className="btn-primary" onClick={() => setCredentials(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
