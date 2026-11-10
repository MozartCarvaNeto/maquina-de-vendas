// frontend/src/components/layout/TermsGate.jsx
// Pede o aceite dos Termos a quem entrou antes dessa exigência existir (ou quando o texto mudou).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import '../account/Account.css';

export default function TermsGate() {
  const [needs, setNeeds] = useState(false);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isOwner = (() => { try { const u = JSON.parse(localStorage.getItem('mdv_user') || '{}'); return u.role === 'owner' || u.role === 'admin'; } catch (_) { return false; } })();

  useEffect(() => {
    api.get('/auth/me').then((r) => setNeeds(!!r.data?.terms?.needsAccept)).catch(() => {});
  }, []);

  async function accept() {
    setBusy(true); setError('');
    try { await api.post('/auth/accept-terms'); setNeeds(false); } catch (e) { setError(e.response?.data?.error || 'Não foi possível registrar o aceite.'); } finally { setBusy(false); }
  }

  if (!needs) return null;
  return (
    <div className="acc-modal-back" role="dialog" aria-modal="true">
      <div className="acc-modal">
        <h2>Termos de Uso e Privacidade</h2>
        <p>Atualizamos nossos <Link to="/termos" target="_blank">Termos de Uso</Link> e nossa <Link to="/privacidade" target="_blank">Política de Privacidade</Link> (LGPD). Para continuar usando o sistema, leia e confirme.</p>
        {!isOwner && <p className="acc-muted">Quem aceita pela empresa é o dono ou um administrador da conta. Peça a ele para entrar e confirmar.</p>}
        {isOwner && (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <span>Li e concordo com os Termos de Uso e a Política de Privacidade.</span>
            </label>
            {error && <div className="acc-msg is-error">{error}</div>}
            <div className="acc-row"><button className="btn-primary" disabled={!ok || busy} onClick={accept}>{busy ? 'Salvando…' : 'Aceitar e continuar'}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
