// frontend/src/components/layout/SubscriptionBanner.jsx
//
// 1) Atualiza os dados do usuário salvos no navegador (ex.: se ele é o
//    administrador da plataforma) a cada vez que o sistema abre.
// 2) Avisa o cliente quando a assinatura está perto de vencer.
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { USER_UPDATED_EVENT } from '../../hooks/useCurrentUser';

function formatDate(value) {
  return new Date(value).toLocaleDateString('pt-BR');
}

export default function SubscriptionBanner({ onUserRefreshed }) {
  const [access, setAccess] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/auth/me')
      .then(({ data }) => {
        if (cancelled) return;
        const stored = JSON.parse(localStorage.getItem('mdv_user') || '{}');
        localStorage.setItem('mdv_user', JSON.stringify({ ...stored, ...data.user }));
        setAccess(data.access && !data.user.isPlatformAdmin ? data.access : null);
        window.dispatchEvent(new Event(USER_UPDATED_EVENT));
        onUserRefreshed?.();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!access || dismissed || access.daysLeft === null) return null;

  const vencida = access.inGrace || access.daysLeft < 0;
  if (!vencida && access.daysLeft > 7) return null;

  let text;
  if (vencida) {
    text = `⚠️ Sua assinatura venceu em ${formatDate(access.endsAt)}. Renove agora para não perder o acesso.`;
  } else if (access.daysLeft <= 1) {
    text = `⏳ Sua assinatura vence em ${formatDate(access.endsAt)} (hoje/amanhã). Renove para não perder o acesso.`;
  } else {
    text = `⏳ Sua assinatura vence em ${access.daysLeft} dias (${formatDate(access.endsAt)}). Renove para não perder o acesso.`;
  }

  return (
    <div className={`sub-banner ${vencida || access.daysLeft <= 2 ? 'is-danger' : ''}`}>
      <span>{text}</span>
      <button onClick={() => setDismissed(true)} aria-label="Fechar aviso">
        ×
      </button>
    </div>
  );
}
