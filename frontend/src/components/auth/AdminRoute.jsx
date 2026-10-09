// frontend/src/components/auth/AdminRoute.jsx
//
// Só deixa abrir a página se o usuário for ADMINISTRADOR DA PLATAFORMA.
// (A proteção de verdade está no servidor; isto só evita telas vazias.)
import { Navigate } from 'react-router-dom';

export default function AdminRoute({ children }) {
  const token = localStorage.getItem('mdv_token');
  const user = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  if (!token) return <Navigate to="/login" replace />;
  if (!user.isPlatformAdmin) return <Navigate to="/" replace />;
  return children;
}
