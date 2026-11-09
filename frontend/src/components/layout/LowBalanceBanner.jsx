// frontend/src/components/layout/LowBalanceBanner.jsx
// Aviso dentro do sistema quando o saldo pré-pago está baixo (some sozinho depois da recarga).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';

export default function LowBalanceBanner() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/gateway/wallet/low').then(({ data }) => alive && setInfo(data)).catch(() => alive && setInfo(null));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!info?.low) return null;
  return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 8, margin: '0 0 12px', fontSize: 14 }}>
      ⚠️ Seu saldo está baixo (R$ {Number(info.balanceBrl).toFixed(2)}). Quando zerar, SMS e ligações são bloqueados. <Link to="/gateway" style={{ fontWeight: 700 }}>Recarregar agora</Link>
    </div>
  );
}
