// frontend/src/components/auth/ProtectedRoute.jsx
import { Navigate } from 'react-router-dom';

export default function ProtectedRoute({ children }) {
  const token = localStorage.getItem('mdv_token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  // Assinatura vencida/pendente: o cliente só enxerga a tela de pagamento.
  if (localStorage.getItem('mdv_restricted') === '1') {
    return <Navigate to="/assinatura" replace />;
  }
  return children;
}