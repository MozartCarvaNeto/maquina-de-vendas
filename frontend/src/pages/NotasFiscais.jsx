// frontend/src/pages/NotasFiscais.jsx
//
// Aba "Notas Fiscais": emissor de NF-e dentro do Turbo Prospect (mesmo login).
// Sem plano de NF-e -> vitrine de planos. Com plano (ou vencido, em modo consulta) -> o emissor numa moldura.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import './Assinatura.css';

const CYCLE_LABEL = { 1: 'mês', 3: 'trimestre', 6: 'semestre', 12: 'ano' };
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');

export default function NotasFiscais() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [frameUrl, setFrameUrl] = useState('');
  const [showPlans, setShowPlans] = useState(false);
  const [chosen, setChosen] = useState(null);
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [payUrl, setPayUrl] = useState('');
  const [paid, setPaid] = useState('');
  const baseline = useRef(0);

  const load = useCallback(async () => {
    const r = await api.get('/nfe/status');
    setData(r.data);
    return r.data;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.response?.data?.error || 'Não foi possível carregar as Notas Fiscais.'));
  }, [load]);

  const hasAccess = data && data.status !== 'sem_plano' && data.configured && data.canManage;

  // abre o emissor (ticket de entrada -> cookie da aba)
  useEffect(() => {
    if (!hasAccess || frameUrl) return;
    api.post('/nfe/session')
      .then((r) => setFrameUrl(r.data.url))
      .catch((e) => setError(e.response?.data?.error || 'Não foi possível abrir o emissor.'));
  }, [hasAccess, frameUrl]);

  // depois de abrir o pagamento, confere a cada 6 s se caiu
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(async () => {
      try {
        const fresh = await load();
        if ((fresh.payments?.length || 0) > baseline.current) {
          setWaiting(false);
          setShowPlans(false);
          setFrameUrl('');
          setPaid('✅ Pagamento confirmado! Seu emissor de NF-e foi liberado.');
        }
      } catch { /* tenta de novo */ }
    }, 6000);
    return () => clearInterval(t);
  }, [waiting, load]);

  async function startCheckout(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      baseline.current = data?.payments?.length || 0;
      const r = await api.post('/nfe/checkout', { planId: chosen.id, cpfCnpj });
      setPayUrl(r.data.payUrl || '');
      setChosen(null);
      setWaiting(true);
      if (r.data.payUrl) window.open(r.data.payUrl, '_blank', 'noopener');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível gerar o pagamento.');
    } finally {
      setBusy(false);
    }
  }

  async function openFull() {
    try {
      const r = await api.post('/nfe/session'); // o ticket é de uso único: pede outro
      window.open(r.data.url, '_blank', 'noopener');
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível abrir.');
    }
  }

  async function cancelRecurring() {
    if (!window.confirm('Cancelar a renovação automática? Você continua usando até o fim do período já pago.')) return;
    try { await api.post('/nfe/cancel'); await load(); } catch (err) { setError(err.response?.data?.error || 'Erro ao cancelar.'); }
  }

  if (!data) return <div className="sub-page"><div className="sub-container">{error ? <div className="sub-alert">{error}</div> : 'Carregando...'}</div></div>;

  const link = payUrl || data.pendingPayment?.url || '';
  const u = data.usage;

  const plansBlock = (
    <section className="sub-card">
      <h2>{data.status === 'sem_plano' ? 'Escolha seu plano de NF-e' : 'Planos de NF-e'}</h2>
      {data.plans.length === 0 && <p>Nenhum plano de NF-e disponível ainda. Fale com o suporte{data.supportContact ? `: ${data.supportContact}` : ''}.</p>}
      <div className="sub-plans">
        {data.plans.map((p) => (
          <div key={p.id} className={`sub-plan ${data.plan?.id === p.id ? 'is-current' : ''}`}>
            <h3>{p.name}</h3>
            <div className="sub-price">{money(p.priceCents)} <small>/ {CYCLE_LABEL[p.cycleMonths]}</small></div>
            {p.description && <p>{p.description}</p>}
            <ul>
              <li>{p.maxMonthlyNotes ? `${p.maxMonthlyNotes} notas por mês` : 'Notas ilimitadas'}</li>
              <li>Várias pessoas da equipe, com o mesmo login</li>
              <li>XML e DANFE guardados</li>
            </ul>
            {data.canManage && data.billingEnabled && (
              <button className="btn-primary" onClick={() => { setChosen(p); setCpfCnpj(data.taxId || ''); }}>
                {data.plan?.id === p.id ? 'Renovar' : 'Contratar'}
              </button>
            )}
          </div>
        ))}
      </div>
      {!data.billingEnabled && <p className="sub-muted">O pagamento automático ainda não está ativo. Fale com o suporte para liberar.</p>}
      {chosen && (
        <form onSubmit={startCheckout} className="sub-checkout">
          <h3>Plano {chosen.name} — {money(chosen.priceCents)} / {CYCLE_LABEL[chosen.cycleMonths]}</h3>
          <label htmlFor="nf-doc">CPF ou CNPJ de quem paga</label>
          <input id="nf-doc" required value={cpfCnpj} onChange={(e) => setCpfCnpj(e.target.value)} placeholder="Somente números" />
          <div><button className="btn-primary" disabled={busy}>{busy ? 'Gerando…' : 'Ir para o pagamento'}</button> <button type="button" className="btn-outline" onClick={() => setChosen(null)}>Cancelar</button></div>
        </form>
      )}
    </section>
  );

  return (
    <div className="sub-page">
      <div className="sub-container" style={{ maxWidth: 1280 }}>
        <header className="sub-header">
          <div><h1>🧾 Notas Fiscais (NF-e)</h1><p>Emissor de notas fiscais — usa o mesmo login do Turbo Prospect.</p></div>
        </header>
        {error && <div className="sub-alert">{error}</div>}
        {paid && <div className="sub-ok">{paid}</div>}
        {!data.configured && <div className="sub-alert">O emissor de NF-e ainda não foi ligado neste servidor. Peça ao administrador da plataforma para concluir a instalação.</div>}
        {!data.canManage && <div className="sub-alert">Só o proprietário ou administradores da conta acessam as Notas Fiscais.</div>}

        {waiting && (
          <div className="sub-ok">Aguardando a confirmação do pagamento… {link && <a href={link} target="_blank" rel="noreferrer">Abrir página de pagamento</a>}</div>
        )}

        {data.status === 'vencida' && (
          <div className="sub-alert">Seu plano de NF-e venceu em {fmtDate(data.endsAt)}. Você pode consultar e baixar suas notas, mas não emitir. Renove abaixo.</div>
        )}

        {data.status !== 'sem_plano' && (
          <section className="sub-card">
            <div className="sub-summary">
              <div><span>Plano</span><strong>{data.isPlatformAdmin ? 'Administrador (sem limite)' : data.plan?.name || '—'}</strong></div>
              <div><span>Vencimento</span><strong>{data.isPlatformAdmin ? '—' : data.endsAt ? fmtDate(data.endsAt) : 'Sem vencimento'}</strong></div>
              <div><span>Notas no mês</span><strong>{u ? `${u.usadas}${data.limit ? ` de ${data.limit}` : ' (sem limite)'}` : '—'}</strong></div>
              {!data.isPlatformAdmin && data.canManage && (
                <div className="sub-summary-actions">
                  <button className="btn-outline" onClick={() => setShowPlans((v) => !v)}>{showPlans ? 'Fechar planos' : 'Ver planos / renovar'}</button>
                  {data.hasRecurring && <button className="btn-outline" onClick={cancelRecurring}>Cancelar renovação</button>}
                </div>
              )}
            </div>
            {link && !waiting && data.pendingPayment && <p>Pagamento em aberto: <a href={link} target="_blank" rel="noreferrer">abrir cobrança</a></p>}
          </section>
        )}

        {(data.status === 'sem_plano' || showPlans) && plansBlock}

        {hasAccess && !showPlans && (
          <div className="nfe-frame-wrap">
            {frameUrl ? (
              <>
                <iframe title="Emissor de NF-e" src={frameUrl} className="nfe-frame" />
                <p className="sub-muted"><button type="button" className="btn-outline" onClick={openFull}>Abrir em tela cheia (nova aba)</button></p>
              </>
            ) : <p>Abrindo o emissor…</p>}
          </div>
        )}
      </div>
    </div>
  );
}
