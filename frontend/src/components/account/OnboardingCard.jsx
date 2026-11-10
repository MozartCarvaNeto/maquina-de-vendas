// frontend/src/components/account/OnboardingCard.jsx — checklist de primeiro acesso (dono/admin)
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import './Account.css';

export default function OnboardingCard() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();
  useEffect(() => { api.get('/account/onboarding').then((r) => setData(r.data)).catch(() => setData(null)); }, []);
  if (!data || data.dismissed || data.done === data.total) return null;
  async function dismiss() { setData({ ...data, dismissed: true }); api.post('/account/onboarding/dismiss', {}).catch(() => {}); }
  return (
    <div className="acc-card">
      <div className="acc-row" style={{ justifyContent: 'space-between', marginTop: 0 }}>
        <h3 style={{ margin: 0 }}>Comece por aqui · {data.done} de {data.total} passos</h3>
        <button className="btn-outline" onClick={dismiss}>Ocultar</button>
      </div>
      <div className="acc-bar" style={{ margin: '8px 0' }}><div style={{ width: `${data.percent}%` }} /></div>
      <ul className="acc-steps">
        {data.steps.map((s) => (
          <li key={s.key} className={s.done ? 'is-done' : ''}>
            <span>{s.done ? '✅' : '⬜'} <strong>{s.title}</strong><div className="acc-muted">{s.desc}</div></span>
            {!s.done && <button className="btn-primary" onClick={() => navigate(s.link)}>{s.cta}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
