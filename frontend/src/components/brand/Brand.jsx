// frontend/src/components/brand/Brand.jsx
//
// Marca do sistema: símbolo + "TURBO PROSPECT" + subtítulo "Máquina de Vendas".
// Para trocar o nome no futuro, mude só as duas linhas abaixo.
import './Brand.css';

export const BRAND_NAME = 'Turbo Prospect';
export const BRAND_SUBTITLE = 'Máquina de Vendas';

/** variant: "auth" (telas de login, grande e centralizada) | "sidebar" | "topbar" (compacta) */
export default function Brand({ variant = 'sidebar' }) {
  const [first, ...rest] = BRAND_NAME.split(' ');
  return (
    <div className={`brand brand-${variant}`}>
      <img className="brand-symbol" src="/brand-symbol.png" alt="" width="256" height="256" />
      <div className="brand-text">
        <span className="brand-name">
          <b>{first.toUpperCase()}</b> <span>{rest.join(' ').toUpperCase()}</span>
        </span>
        <small className="brand-subtitle">{BRAND_SUBTITLE}</small>
      </div>
    </div>
  );
}
