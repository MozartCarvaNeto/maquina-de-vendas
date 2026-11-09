// frontend/src/components/gateway/SaldoExtras.jsx
// Saldo: recarga pelo cliente (Pix/cartão), extrato, aviso de saldo baixo; e (administrador) custos e lucro.
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const errText = (e) => e.response?.data?.error || e.message || 'Erro';
const CAT = { recarga: 'Recarga', voz: 'Ligação', sms: 'SMS', numero: 'Mensalidade de número', outros: 'Outros' };
const ymd = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

export function TopupBox({ me, flash, reload }) {
  const [amount, setAmount] = useState('50');
  const [cpf, setCpf] = useState('');
  const [busy, setBusy] = useState(false);
  const [low, setLow] = useState(me.lowBalanceBrl ?? '');
  const t = me.topup || {};
  const go = async () => {
    setBusy(true);
    try {
      const r = (await api.post('/gateway/wallet/topup', { amountBrl: amount, cpfCnpj: cpf })).data;
      if (r.payUrl) window.open(r.payUrl, '_blank', 'noopener');
      flash('✅ Cobrança criada. Pague por Pix ou cartão na página que abriu; o saldo entra sozinho em instantes.');
      reload();
    } catch (e) { flash(`❌ ${errText(e)}`); }
    setBusy(false);
  };
  const saveLow = async () => {
    try { await api.put('/gateway/wallet/low-balance', { lowBalanceBrl: low === '' ? null : low }); flash('✅ Aviso de saldo baixo salvo.'); reload(); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  return (
    <div className="gw-form">
      {me.lowBalance && <div className="hint-text" style={{ color: '#b91c1c', fontWeight: 600 }}>⚠️ Saldo baixo. Recarregue para não bloquear envios e ligações.</div>}
      <h4>💳 Comprar saldo</h4>
      {t.enabled ? (
        <>
          <div className="gw-row">
            <div><label>Valor (R$ {Number(t.minBrl).toFixed(0)} a {Number(t.maxBrl).toFixed(0)})</label><input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>{[20, 50, 100, 200].map((v) => <button key={v} type="button" className="btn-secondary-small" onClick={() => setAmount(String(v))}>R$ {v}</button>)}</div>
            <div><label>CPF ou CNPJ (só na 1ª compra)</label><input placeholder="somente números" value={cpf} onChange={(e) => setCpf(e.target.value)} /></div>
            <button type="button" className="btn-primary" disabled={busy} onClick={go}>Pagar com Pix ou cartão</button>
          </div>
          <p className="hint-text">Você paga na página segura do Asaas (Pix, cartão ou boleto). Quando o pagamento é confirmado, o saldo entra automaticamente e mensalidades de número em atraso são regularizadas.</p>
        </>
      ) : <p className="hint-text">A compra online de saldo não está disponível agora. Peça a recarga ao administrador do serviço.</p>}
      {!!me.topups?.length && (
        <table className="gw-table">
          <thead><tr><th>Quando</th><th>Valor</th><th>Situação</th><th /></tr></thead>
          <tbody>{me.topups.slice(0, 5).map((x) => (
            <tr key={x.id}><td>{new Date(x.createdAt).toLocaleString('pt-BR')}</td><td>{brl(x.amountBrl)}</td><td>{x.status === 'paid' ? '✅ Pago' : x.status === 'pending' ? '⏳ Aguardando pagamento' : '—'}</td><td>{x.payUrl && <a href={x.payUrl} target="_blank" rel="noopener noreferrer">Pagar</a>}</td></tr>
          ))}</tbody>
        </table>
      )}
      <div className="gw-row">
        <div><label>Avisar por e-mail quando o saldo ficar abaixo de (R$)</label><input placeholder={`padrão: ${me.lowDefaultBrl}`} value={low} onChange={(e) => setLow(e.target.value)} /></div>
        <button type="button" className="btn-secondary-small" onClick={saveLow}>Salvar aviso</button>
      </div>
    </div>
  );
}

export function ExtratoBox({ flash }) {
  const now = new Date();
  const [from, setFrom] = useState(ymd(new Date(now.getTime() - 30 * 864e5)));
  const [to, setTo] = useState(ymd(now));
  const [st, setSt] = useState(null);
  const load = useCallback(async () => {
    try { setSt((await api.get('/gateway/wallet/statement', { params: { from, to } })).data); } catch (e) { flash(`❌ ${errText(e)}`); }
  }, [from, to, flash]);
  useEffect(() => { load(); }, [load]);
  const csv = async () => {
    try {
      const r = await api.get('/gateway/wallet/statement', { params: { from, to, format: 'csv' }, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `extrato-${from}-a-${to}.csv`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  const s = st?.summary;
  return (
    <div className="gw-form">
      <h4>🧾 Extrato</h4>
      <div className="gw-row">
        <div><label>De</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>Até</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button type="button" className="btn-secondary-small" onClick={csv}>Baixar planilha (CSV)</button>
      </div>
      {s && (
        <div className="gw-row" style={{ flexWrap: 'wrap' }}>
          <div className="card" style={{ minWidth: 150 }}><small>Recargas</small><br /><strong>{brl(s.recarga)}</strong></div>
          <div className="card" style={{ minWidth: 150 }}><small>Ligações</small><br /><strong>{brl(s.voz.amountBrl)}</strong><br /><small>{s.voz.minutes.toFixed(1)} min · {s.voz.calls} ligação(ões)</small></div>
          <div className="card" style={{ minWidth: 150 }}><small>SMS</small><br /><strong>{brl(s.sms.amountBrl)}</strong><br /><small>{s.sms.parts} parte(s) · {s.sms.messages} envio(s)</small></div>
          <div className="card" style={{ minWidth: 150 }}><small>Mensalidade de números</small><br /><strong>{brl(s.numero.amountBrl)}</strong></div>
        </div>
      )}
      <table className="gw-table">
        <thead><tr><th>Quando</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th>Saldo</th></tr></thead>
        <tbody>
          {(st?.txs || []).slice(0, 300).map((t) => (
            <tr key={t.id}><td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td><td>{CAT[t.category] || t.category}</td><td>{t.description}</td>
              <td style={{ color: t.amountBrl < 0 ? '#b91c1c' : '#15803d' }}>{brl(t.amountBrl)}</td><td>{brl(t.balanceAfter)}</td></tr>
          ))}
          {!(st?.txs || []).length && <tr><td colSpan={5}>Sem movimentações no período.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const FIELDS = [
  ['voiceCostOutPerMinBrl', 'Custo da ligação feita (R$/min) — o que você paga ao fornecedor'],
  ['voiceCostInPerMinBrl', 'Custo da ligação recebida (R$/min)'],
  ['didCostMonthlyBrl', 'Custo mensal de cada número (R$)'],
  ['smsCostFallbackBrl', 'Custo do SMS quando a operadora não tem custo cadastrado (R$/parte)'],
  ['walletLowDefaultBrl', 'Aviso de saldo baixo padrão (R$)'],
  ['topupMinBrl', 'Recarga mínima (R$)'],
  ['topupMaxBrl', 'Recarga máxima (R$)']
];

export function RegrasBox({ flash }) {
  const [r, setR] = useState(null);
  useEffect(() => { api.get('/gateway/admin/billing-rules').then((x) => setR(x.data)).catch((e) => flash(`❌ ${errText(e)}`)); }, [flash]);
  if (!r) return null;
  const save = async () => {
    try { setR((await api.put('/gateway/admin/billing-rules', r)).data); flash('✅ Regras salvas.'); } catch (e) { flash(`❌ ${errText(e)}`); }
  };
  return (
    <div className="gw-form">
      <h4>⚙️ Custos e recarga (só administrador)</h4>
      <div className="gw-row" style={{ flexWrap: 'wrap' }}>
        {FIELDS.map(([k, l]) => <div key={k}><label>{l}</label><input value={r[k] ?? ''} onChange={(e) => setR({ ...r, [k]: e.target.value })} /></div>)}
        <div><label>Custo cobrado a cada</label>
          <select value={r.voiceCostIncrementSec} onChange={(e) => setR({ ...r, voiceCostIncrementSec: Number(e.target.value) })}><option value={1}>1 segundo</option><option value={6}>6 segundos</option><option value={30}>30 segundos</option><option value={60}>1 minuto</option></select></div>
      </div>
      <label><input type="checkbox" checked={!!r.topupEnabled} onChange={(e) => setR({ ...r, topupEnabled: e.target.checked })} /> Permitir que o cliente compre saldo (Pix/cartão pelo Asaas)</label>
      <label><input type="checkbox" checked={!!r.topupAutoEnable} onChange={(e) => setR({ ...r, topupAutoEnable: e.target.checked })} /> Ligar o pré-pago da conta na 1ª recarga paga (lembre de definir as tarifas dela)</label>
      <button type="button" className="btn-primary" onClick={save}>Salvar regras</button>
      <p className="hint-text">Os custos alimentam o painel de lucro abaixo. O custo do SMS usa o valor por parte cadastrado em cada operadora.</p>
    </div>
  );
}

export function LucroBox({ flash }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { api.get('/gateway/admin/profit', { params: { months: 6 } }).then((x) => setD(x.data)).catch((e) => flash(`❌ ${errText(e)}`)); }, [flash]);
  if (!d) return null;
  const Row = ({ m }) => (
    <>
      <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === m.month ? null : m.month)}>
        <td>{m.month}</td><td>{brl(m.total.revenue)}</td><td>{brl(m.total.cost)}</td><td style={{ color: m.total.profit < 0 ? '#b91c1c' : '#15803d', fontWeight: 600 }}>{brl(m.total.profit)}</td><td>{m.total.marginPct}%</td><td>{brl(m.topups)}</td>
      </tr>
      {open === m.month && (
        <tr><td colSpan={6}>
          <small>Ligações: receita {brl(m.voice.revenue)} · custo {brl(m.voice.cost)} · lucro {brl(m.voice.profit)} · {m.voice.minutes} min<br />
            SMS: receita {brl(m.sms.revenue)} · custo {brl(m.sms.cost)} · lucro {brl(m.sms.profit)} · {m.sms.parts} parte(s)<br />
            Números: receita {brl(m.numbers.revenue)} · custo {brl(m.numbers.cost)} · lucro {brl(m.numbers.profit)} · {m.numbers.charges} cobrança(s)</small>
          <table className="gw-table"><thead><tr><th>Cliente</th><th>Receita</th><th>Custo</th><th>Lucro</th></tr></thead>
            <tbody>{m.byAccount.slice(0, 15).map((a) => <tr key={a.accountId}><td>{a.name}</td><td>{brl(a.revenue)}</td><td>{brl(a.cost)}</td><td>{brl(a.profit)}</td></tr>)}{!m.byAccount.length && <tr><td colSpan={4}>Sem movimento.</td></tr>}</tbody></table>
        </td></tr>
      )}
    </>
  );
  return (
    <div className="gw-form">
      <h4>📈 Lucro por mês (só administrador)</h4>
      <table className="gw-table">
        <thead><tr><th>Mês</th><th>Receita (clientes)</th><th>Custo (fornecedor)</th><th>Lucro</th><th>Margem</th><th>Recargas recebidas</th></tr></thead>
        <tbody>{d.months.map((m) => <Row key={m.month} m={m} />)}</tbody>
      </table>
      <p className="hint-text">Receita = o que saiu do saldo dos clientes (ligações, SMS, mensalidades). Custo = o que você paga ao fornecedor segundo as regras acima (ligações e números) e o custo real das operadoras de SMS. Ligações feitas antes de cadastrar os custos aparecem com custo zero. Clique no mês para ver por cliente.</p>
    </div>
  );
}
