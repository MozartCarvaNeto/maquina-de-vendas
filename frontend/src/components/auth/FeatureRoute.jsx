// frontend/src/components/auth/FeatureRoute.jsx
//
// Protege uma página por MÓDULO do plano. Se o plano do cliente não inclui,
// mostra uma tela explicando (em vez de uma página quebrada).
import { Link } from 'react-router-dom';
import useCurrentUser from '../../hooks/useCurrentUser';
import { userHasFeature, FEATURE_NAMES } from '../../utils/features';
import './FeatureRoute.css';

export function FeatureLocked({ feature }) {
  const user = useCurrentUser();
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  const name = FEATURE_NAMES[Array.isArray(feature) ? feature[0] : feature] || 'Este recurso';

  return (
    <div className="feature-locked">
      <div className="feature-locked-card">
        <div className="feature-locked-icon">🔒</div>
        <h1>{name}</h1>
        <p>Este recurso não está incluído no seu plano atual.</p>
        <p className="feature-locked-hint">
          {isAdmin
            ? 'Veja os planos disponíveis ou fale com o suporte para liberar este módulo.'
            : 'Peça ao administrador da sua conta para contratar este módulo.'}
        </p>
        <div className="feature-locked-actions">
          {isAdmin && <Link className="btn-primary" to="/assinatura">Ver meu plano</Link>}
          <Link className="btn-outline" to="/">Voltar ao início</Link>
        </div>
      </div>
    </div>
  );
}

/** `feature` pode ser uma chave ou uma lista (basta uma estar liberada). */
export default function FeatureRoute({ feature, children }) {
  const user = useCurrentUser();
  const keys = Array.isArray(feature) ? feature : [feature];
  if (!userHasFeature(user, ...keys)) return <FeatureLocked feature={keys} />;
  return children;
}
