// frontend/src/components/layout/Layout.jsx
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Brand from '../brand/Brand';
import SubscriptionBanner from './SubscriptionBanner';
import './Layout.css';

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [, setUserVersion] = useState(0); // força o menu a reler o usuário salvo
  const location = useLocation();

  // No celular, fecha o menu sempre que a pessoa escolhe uma página.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-layout">
      <header className="app-topbar">
        <button className="app-topbar-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          ☰
        </button>
        <Brand variant="topbar" />
      </header>

      {menuOpen && <div className="app-sidebar-backdrop" onClick={() => setMenuOpen(false)} />}

      <Sidebar open={menuOpen} />

      <main className="app-main-content">
        <SubscriptionBanner onUserRefreshed={() => setUserVersion((v) => v + 1)} />
        <Outlet />
      </main>
    </div>
  );
}
