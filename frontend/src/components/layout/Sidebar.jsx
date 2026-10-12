// frontend/src/components/layout/Sidebar.jsx
import { NavLink, useNavigate } from 'react-router-dom';
import { useFollowUps } from '../../hooks/useFollowUps';
import Brand from '../brand/Brand';
import useCurrentUser from '../../hooks/useCurrentUser';
import { userHasFeature } from '../../utils/features';
import '../crm/FollowUps.css';
import './Sidebar.css';

const MENU_ITEMS = [
  { path: '/', label: '📊 Dashboard', end: true, adminOnly: false },
  { path: '/chat', label: '💬 Chat', feature: ['chat'], adminOnly: false },
  { path: '/crm', label: '📋 CRM', feature: ['crm'], adminOnly: false },
  { path: '/campanhas', label: '🎯 Campanhas', feature: ['contatos'], adminOnly: false },
  { path: '/buscar-empresas', label: '🔍 Buscar Empresas', feature: ['contatos'], adminOnly: false },
  { path: '/listas', label: '🗂️ Listas', feature: ['contatos'], adminOnly: false },
  { path: '/disparos', label: '📣 Disparos', feature: ['disparos'], adminOnly: false },
  { path: '/conexoes', label: '📱 Conexões', feature: ['conexoes'], adminOnly: false },
  { path: '/discador', label: '📞 Discador', feature: ['discador'], adminOnly: false },
  { path: '/ligacoes', label: '☎️ Ligações', feature: ['robo', 'discador', 'agente_ia'], adminOnly: false },
  { path: '/linhas', label: '🔀 Linhas', feature: ['discador', 'robo', 'agente_ia'], adminOnly: true },
  { path: '/equipe', label: '🧑‍🤝‍🧑 Equipe', adminOnly: true },
  { path: '/contatos', label: '👥 Contatos', feature: ['contatos'], adminOnly: false },
  { path: '/configuracoes', label: '⚙️ Configurações', adminOnly: true },
  { path: '/assinatura', label: '💳 Minha assinatura', adminOnly: true, hideForPlatformAdmin: true },
  { path: '/admin', label: '🛡️ Administração', platformAdminOnly: true }
];

export default function Sidebar({ open = false }) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  const followUps = useFollowUps();
  const dueTotal = followUps.counts.overdue + followUps.counts.today;

  function handleLogout() {
    localStorage.removeItem('mdv_token');
    localStorage.removeItem('mdv_user');
    localStorage.removeItem('mdv_restricted');
    navigate('/login');
  }

  const visibleItems = MENU_ITEMS.filter(
    (item) =>
      (!item.adminOnly || isAdmin) &&
      (!item.platformAdminOnly || user.isPlatformAdmin) &&
      !(item.hideForPlatformAdmin && user.isPlatformAdmin)
  );

  return (
    <nav className={`sidebar ${open ? 'open' : ''}`}>
      <Brand variant="sidebar" />

      <ul className="sidebar-menu">
        {visibleItems.map((item) => {
          // Módulo fora do plano: continua no menu, com cadeado (mostra o que dá para contratar).
          const locked = item.feature && !userHasFeature(user, ...item.feature);
          return (
          <li key={item.path}>
            <NavLink
              to={item.path}
              end={item.end}
              className={({ isActive }) => `${isActive ? 'active' : ''} ${locked ? 'locked' : ''}`.trim()}
              title={locked ? 'Não incluído no seu plano' : undefined}
            >
              {item.label}
              {locked && <span className="sidebar-lock" aria-label="Não incluído no plano">🔒</span>}
              {item.path === '/crm' && dueTotal > 0 && (
                <span
                  className={`sidebar-badge ${followUps.counts.overdue > 0 ? 'is-overdue' : ''}`}
                  title="Retornos de clientes para hoje / atrasados"
                >
                  {dueTotal}
                </span>
              )}
            </NavLink>
          </li>
          );
        })}
      </ul>

      <div className="sidebar-footer">
        <strong>{user.name}</strong>
        <span className="sidebar-role">{user.isPlatformAdmin ? 'Administrador da plataforma' : user.role === 'owner' ? 'Proprietário' : user.role === 'admin' ? 'Administrador' : 'Vendedor'}</span>
        <button onClick={handleLogout}>🚪 Sair</button>
      </div>
    </nav>
  );
}