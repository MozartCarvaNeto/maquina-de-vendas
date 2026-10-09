// frontend/src/pages/Assinatura.jsx
//
// Área do CLIENTE: situação da assinatura, uso do plano, escolha de plano e
// pagamento. Também é a ÚNICA tela que uma conta vencida (ou cadastro pendente)
// consegue abrir quando a cobrança automática está ativa.
import { useState, useEffect, useCallback, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import api from '../services/api';
import './Assinatura.css';

const CYCLE_LABEL = { 1: 'mês', 3: 'trimestre', 6: 'semestre', 12: 'ano' };
const STATUS_LABEL = { pendente: 'Aguardando pagamento', ativa: 'Ativa', expirada: 'Vencida', bloqueada: 'Bloqueada' };

const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (value) => (value ? new Date(value).toLocaleDateString('pt-BR') : '—');

function UsageBar({ label, used, limit }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = limit && used >= limit ? 'danger' : limit && pct >= 80 ? 'warn' : '';
  return (
    <div className="sub-usage">
      <div className="sub-usage-head">
        <span>{label}</span>
        <strong>{limit === null || limit === undefined ? `${used} (sem limite)` : `${used} de ${limit}`}</strong>
      </div>
      {limit ? (
        <div className="sub-bar">
          <div className={`sub-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export default function Assinatura() {
  const navigate = useNavigate();
  const token = localStorage.getItem('mdv_token');
  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(null);
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [busy, setBusy] = useState(false);
  const [payUrl, setPayUrl] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [paidMessage, setPaidMessage] = useState('');
  const baselinePayments = useRef(0);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([api.get('/billing/status'), api.get('/billing/plans')]);
    setStatus(s.data);
    setPlans(p.data.plans);
    setCatalog(p.data.featureCatalog || s.data.featureCatalog || []);
    if (s.data.account.allowed) localStorage.removeItem('mdv_restricted');
    return s.data;
  }, []);

  useEffect(() => {
    if (!token) return;
    load().catch((e) => setError(e.response?.data?.error || 'Não foi possível carregar sua assinatura.'));
  }, [token, load]);

  // Depois de abrir a página de pagamento, confere a cada 6 s se o pagamento caiu.
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(async () => {
      try {
        const fresh = await load();
        if (fresh.payments.length > baselinePayments.current) {
          setWaiting(false);
          setPaidMessage('✅ Pagamento confirmado! Seu acesso foi liberado.');
          setTimeout(() => navigate('/'), 2500);
        }
      } catch {
        /* tenta de novo no próximo ciclo */
      }
    }, 6000);
    return () => clearInterval(timer);
  }, [waiting, load, navigate]);

  if (!token) return <Navigate to="/login" replace />;

  function logout() {
    localStorage.removeItem('mdv_token');
    localStorage.removeItem('mdv_user');
    localStorage.removeItem('mdv_restricted');
    navigate('/login');
  }

  async function startCheckout(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      baselinePayments.current = status?.payments?.length || 0;
      const { data } = await api.post('/billing/checkout', { planId: chosen.id, cpfCnpj });
      setPayUrl(data.payUrl || '');
      setChosen(null);
      setWaiting(true);
      if (data.payUrl) window.open(data.payUrl, '_blank', 'noopener');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível gerar o pagamento.');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <div className="sub-page"><div className="sub-container">{error ? <div className="sub-alert">{error}</div> : 'Carregando...'}</div></div>;
  }

  const { account, plan, usage, limits, pendingPayment, payments } = status;
  const link = payUrl || pendingPayment?.url || '';

  return (
    <div className="sub-page">
      <div className="sub-container">
        <header className="sub-header">
          <div>
            <h1>💳 Minha assinatura</h1>
            <p>{account.name}</p>
          </div>
          <div className="sub-header-actions">
            {account.allowed && <button className="btn-outline" onClick={() => navigate('/')}>← Voltar ao sistema</button>}
            <button className="btn-outline" onClick={logout}>Sair</button>
          </div>
        </header>

        {error && <div className="sub-alert">{error}</div>}
        {paidMessage && <div className="sub-ok">{paidMessage}</div>}

        {!account.allowed && (
          <div className="sub-alert">
            {account.status === 'pendente'
              ? 'Seu cadastro está aguardando a escolha e o pagamento de um plano. Escolha abaixo para liberar o acesso.'
              : `Sua assinatura venceu em ${fmtDate(account.endsAt)}. Renove abaixo para voltar a usar o sistema — seus dados estão guardados.`}
          </div>
        )}

        <section className="sub-card">
          <div className="sub-summary">
            <div><span>Situação</span><strong className={`sub-st sub-st-${account.status}`}>{STATUS_LABEL[account.status] || account.status}</strong></div>
            <div><span>Plano</span><strong>{plan ? plan.name : '—'}</strong></div>
            <div><span>Vencimento</span><strong>{account.endsAt ? fmtDate(account.endsAt) : 'Sem vencimento'}</strong></div>
            <div>
              <span>Tempo restante</span>
              <strong>{account.endsAt ? (account.daysLeft >= 0 ? `${account.daysLeft} dia${account.daysLeft === 1 ? '' : 's'}` : 'Vencida') : '—'}</strong>
            </div>
          </div>

          {link && (
            <div className="sub-pay">
              <div>
                <strong>Há um pagamento em aberto{pendingPayment?.value ? ` de ${pendingPayment.value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : ''}</strong>
                <span>PIX, boleto ou cartão — a liberação é automática assim que o pagamento é confirmado.</span>
              </div>
              <a className="btn-primary" href={link} target="_blank" rel="noopener noreferrer">Pagar agora</a>
            </div>
          )}
          {waiting && <p className="sub-waiting">⏳ Aguardando a confirmação do pagamento… esta tela atualiza sozinha.</p>}
        </section>

        {account.allowed && (
          <section className="sub-card">
            <h2>Uso do plano</h2>
            <UsageBar label="Conexões de WhatsApp" used={usage.connections} limit={limits?.maxWhatsappConnections ?? null} />
            <UsageBar label="Usuários" used={usage.members} limit={limits?.maxMembers ?? null} />
            <UsageBar label={`Mensagens de disparos em ${usage.period}`} used={usage.messages} limit={limits?.maxMonthlyMessages ?? null} />
          </section>
        )}

        {account.allowed && catalog.length > 0 && (
          <section className="sub-card">
            <h2>O que seu plano inclui</h2>
            <ul className="sub-features">
              {catalog.map((f) => {
                const on = !Array.isArray(status.features) || status.features.includes(f.key);
                return (
                  <li key={f.key} className={on ? 'is-on' : 'is-off'}>
                    <span>{on ? '✅' : '🔒'}</span> {f.icon} {f.label}
                  </li>
                );
              })}
            </ul>
            {Array.isArray(status.features) && <p className="sub-note-inline">Os itens com 🔒 não estão no seu plano. Fale com o suporte para contratar.</p>}
          </section>
        )}

        {status.billingEnabled && status.canManage && plans.length > 0 && (
          <section className="sub-card">
            <h2>{plan ? 'Renovar ou trocar de plano' : 'Escolha seu plano'}</h2>
            <div className="sub-plans">
              {plans.map((p) => (
                <div key={p.id} className={`sub-plan ${plan?.id === p.id ? 'is-current' : ''}`}>
                  <h3>{p.name}</h3>
                  <div className="sub-price">{money(p.priceCents)}<small> / {CYCLE_LABEL[p.cycleMonths] || `${p.cycleMonths} meses`}</small></div>
                  {p.description && <p className="sub-desc">{p.description}</p>}
                  <ul>
                    <li>🧩 {Array.isArray(p.features) ? catalog.filter((f) => p.features.includes(f.key)).map((f) => f.label.split(' (')[0]).join(', ') : 'Todas as funcionalidades'}</li>
                    <li>📱 {p.maxWhatsappConnections ?? 'Até 10'} conexão(ões) de WhatsApp</li>
                    <li>👥 {p.maxMembers ?? 'Ilimitados'} usuário(s)</li>
                    <li>📣 {p.maxMonthlyMessages !== null ? `${p.maxMonthlyMessages.toLocaleString('pt-BR')} mensagens/mês` : 'Mensagens ilimitadas'}</li>
                  </ul>
                  <button className="btn-primary" onClick={() => { setChosen(p); setError(''); }}>
                    {plan?.id === p.id ? (account.allowed ? 'Renovar este plano' : 'Pagar este plano') : 'Escolher'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {status.billingEnabled && !status.canManage && (
          <div className="sub-note">Só o proprietário ou administrador da conta pode contratar ou renovar o plano.</div>
        )}

        {payments.length > 0 && (
          <section className="sub-card">
            <h2>Pagamentos</h2>
            <ul className="sub-history">
              {payments.map((p) => (
                <li key={p.id}>
                  <span>{fmtDate(p.paidAt)}</span>
                  <strong>{money(p.amountCents)}</strong>
                  {p.invoiceUrl && <a href={p.invoiceUrl} target="_blank" rel="noopener noreferrer">Comprovante</a>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {status.supportContact && <p className="sub-support">Dúvidas sobre cobrança? {status.supportContact}</p>}
      </div>

      {chosen && (
        <div className="modal-overlay" onClick={() => !busy && setChosen(null)}>
          <div className="modal sub-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Plano {chosen.name}</h2>
            <p className="sub-modal-price">{money(chosen.priceCents)} a cada {CYCLE_LABEL[chosen.cycleMonths] || `${chosen.cycleMonths} meses`}, renovando automaticamente. Cancele quando quiser.</p>
            <form onSubmit={startCheckout}>
              <label>CPF ou CNPJ (para emitir a cobrança)</label>
              <input
                inputMode="numeric"
                autoComplete="off"
                placeholder="Somente números"
                value={cpfCnpj}
                onChange={(e) => setCpfCnpj(e.target.value)}
                required
              />
              <p className="sub-modal-note">Na próxima página você escolhe PIX, boleto ou cartão.</p>
              <div className="sub-modal-actions">
                <button type="button" className="btn-outline" disabled={busy} onClick={() => setChosen(null)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Gerando...' : 'Ir para o pagamento'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
