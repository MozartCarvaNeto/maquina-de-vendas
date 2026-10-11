// frontend/src/components/layout/NavButtons.jsx
// Setas "Voltar" e "Início" para todas as páginas (principalmente no celular).
import { useLocation, useNavigate } from 'react-router-dom';

export default function NavButtons({ compact = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === '/';
  if (isHome) return null;

  function goBack() {
    // Se não há página anterior dentro do app (abriu direto pelo link), vai para o início.
    if (window.history.state && window.history.state.idx > 0) navigate(-1);
    else navigate('/');
  }

  return (
    <nav className={`nav-buttons${compact ? ' is-compact' : ''}`} aria-label="Navegação">
      <button type="button" onClick={goBack} aria-label="Voltar para a página anterior">
        <span aria-hidden="true">←</span>
        <span className="nav-buttons-label">Voltar</span>
      </button>
      <button type="button" onClick={() => navigate('/')} aria-label="Ir para o início">
        <span aria-hidden="true">🏠</span>
        <span className="nav-buttons-label">Início</span>
      </button>
    </nav>
  );
}
