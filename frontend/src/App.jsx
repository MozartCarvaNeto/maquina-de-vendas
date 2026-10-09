// frontend/src/App.jsx
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Layout from './components/layout/Layout';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AdminRoute from './components/auth/AdminRoute';
import FeatureRoute from './components/auth/FeatureRoute';
import Admin from './pages/Admin';
import Assinatura from './pages/Assinatura';
import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import CRM from './pages/CRM';
import Campanhas from './pages/Campanhas';
import Listas from './pages/Listas';
import Disparos from './pages/Disparos';
import Conexoes from './pages/Conexoes';
import Discador from './pages/Discador';
import Ligacoes from './pages/Ligacoes';
import Linhas from './pages/Linhas';
import Equipe from './pages/Equipe';
import Contatos from './pages/Contatos';
import Configuracoes from './pages/Configuracoes';
import CallPopup from './components/calls/CallPopup';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/registrar" element={<Register />} />
        <Route path="/esqueci-senha" element={<ForgotPassword />} />
        <Route path="/redefinir-senha" element={<ResetPassword />} />
        {/* Fora do Layout: clientes com assinatura vencida só enxergam esta tela. */}
        <Route path="/assinatura" element={<Assinatura />} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="chat" element={<FeatureRoute feature="chat"><Chat /></FeatureRoute>} />
          <Route path="crm" element={<FeatureRoute feature="crm"><CRM /></FeatureRoute>} />
          <Route path="campanhas" element={<FeatureRoute feature="contatos"><Campanhas /></FeatureRoute>} />
          <Route path="listas" element={<FeatureRoute feature="contatos"><Listas /></FeatureRoute>} />
          <Route path="disparos" element={<FeatureRoute feature="disparos"><Disparos /></FeatureRoute>} />
          <Route path="conexoes" element={<FeatureRoute feature="conexoes"><Conexoes /></FeatureRoute>} />
          <Route path="discador" element={<FeatureRoute feature="discador"><Discador /></FeatureRoute>} />
          <Route path="ligacoes" element={<FeatureRoute feature={['robo', 'discador', 'agente_ia']}><Ligacoes /></FeatureRoute>} />
          <Route path="robo-ligacoes" element={<FeatureRoute feature={['robo', 'discador', 'agente_ia']}><Ligacoes /></FeatureRoute>} />
          <Route path="linhas" element={<FeatureRoute feature={['discador', 'robo', 'agente_ia']}><Linhas /></FeatureRoute>} />
          <Route path="equipe" element={<Equipe />} />
          <Route path="contatos" element={<FeatureRoute feature="contatos"><Contatos /></FeatureRoute>} />
          <Route path="configuracoes" element={<Configuracoes />} />
          <Route
            path="admin"
            element={
              <AdminRoute>
                <Admin />
              </AdminRoute>
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <CallPopup />
    </>
  );
}