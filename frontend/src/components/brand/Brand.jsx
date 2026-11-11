// frontend/src/components/brand/Brand.jsx
//
// Marca do sistema: símbolo + "TURBO PROSPECT" + subtítulo "Máquina de Vendas".
// Para trocar o nome no futuro, mude só as duas linhas abaixo.
import { useEffect } from 'react';
import useCurrentUser from '../../hooks/useCurrentUser';
import './Brand.css';

export const BRAND_NAME = 'Turbo Prospect';
export const BRAND_SUBTITLE = 'Máquina de Vendas';

/** variant: "auth" (telas de login, grande e centralizada) | "sidebar" | "topbar" (compacta) */
export default function Brand({ variant = 'sidebar' }) {
  const user = useCurrentUser();
  const custom = variant !== 'auth' ? user?.brand : null; // marca própria só dentro do painel
  const [first, ...rest] = (custom?.name || BRAND_NAME).split(' ');

  // Cor da marca própria: troca o azul padrão do sistema.
  useEffect(() => {
    const root = document.documentElement;
    const color = custom?.color;
    if (color) {
      root.style.setProperty('--primary-500', color);
      root.style.setProperty('--primary-600', color);
      root.style.setProperty('--primary-700', color);
      root.style.setProperty('--primary-gradient', color);
    } else {
      ['--primary-500', '--primary-600', '--primary-700', '--primary-gradient'].forEach((k) => root.style.removeProperty(k));
    }
  }, [custom?.color]);

  return (
    <div className={`brand brand-${variant}`}>
      <img className="brand-symbol" src={custom?.logo || '/brand-symbol.png'} alt="" width="256" height="256" />
      <div className="brand-text">
        <span className="brand-name">
          <b>{first.toUpperCase()}</b> <span>{rest.join(' ').toUpperCase()}</span>
        </span>
        <small className="brand-subtitle">{custom ? custom.subtitle || '' : BRAND_SUBTITLE}</small>
      </div>
    </div>
  );
}
