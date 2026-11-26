// Vitrine do assinante: o que a plataforma oferece em telefonia/SMS, quanto custa e quanto o plano já inclui.
// O assinante NÃO configura nada aqui — só enxerga as tarifas, o saldo e os números dele.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function PbxServicos() {
  const [c, setC] = useState(null);
  const [erro, setErro] = useState('');
  useEffect(() => { api.get('/pbx/catalog').then((r) => setC(r.data)).catch((e) => setErro(e.response?.data?.error || e.message)); }, []);
  if (erro) return <p className="pbx-flash">❌ {erro}</p>;
  if (!c) return <p>Carregando…</p>;
  return (
    <div className="card">
      <h3>Serviços de telefonia da plataforma</h3>
      <p className="hint-text">A central telefônica, os fornecedores e os números são mantidos pela plataforma. Você usa e paga só pelo que consumir{c.prepaid ? ', descontado do seu saldo pré-pago' : ''}.</p>
      {c.prepaid && (
        <p><strong>Saldo: {brl(c.balanceBrl)}</strong> · <Link to="/gateway">Recarregar na aba Saldo do Gateway</Link></p>
      )}
      <table className="pbx-table">
        <thead><tr><th>Serviço</th><th>Tarifa</th><th>Incluso no seu plano</th></tr></thead>
        <tbody>
          {c.services.map((s) => (
            <tr key={s.key}>
              <td data-label="Serviço">{s.name}</td>
              <td data-label="Tarifa">{s.priceBrl > 0 ? `${brl(s.priceBrl)} ${s.unit}${s.incrementSec ? ` (cobrança a cada ${s.incrementSec}s)` : ''}` : 'Incluído / sem cobrança extra'}</td>
              <td data-label="Incluso no plano">{s.includedPerMonth == null ? 'Conforme o plano' : `${s.includedPerMonth.toLocaleString('pt-BR')} ${s.key === 'did' ? 'número(s)' : s.key.startsWith('voice') ? 'min/mês' : '/mês'}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.plan && <p className="hint-text">Seu plano: <strong>{c.plan.name}</strong>. Precisa de mais minutos, SMS ou números? Fale com o suporte ou mude de plano em Assinatura.</p>}
      <h4>Seus números</h4>
      {c.dids.length === 0 ? <p className="hint-text">Você ainda não tem número de telefone. Solicite à plataforma.</p> : (
        <ul>{c.dids.map((d) => <li key={d.number}>{d.number}{d.label ? ` — ${d.label}` : ''}{d.suspended ? ' (suspenso)' : ''}</li>)}</ul>
      )}
      <p className="hint-text">URA, filas e rotas de entrada são configuradas pela equipe da plataforma. Para mudar o atendimento da sua linha, peça ao suporte.</p>
    </div>
  );
}
