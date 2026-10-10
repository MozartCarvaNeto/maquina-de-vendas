// frontend/src/pages/Login.jsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../services/api';
import PasswordInput from '../components/auth/PasswordInput';
import usePublicConfig from '../hooks/usePublicConfig';
import Brand from '../components/brand/Brand';
import './Auth.css';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Se o sistema te tirou da conta (assinatura vencida/bloqueio), mostra o motivo aqui.
  const [error, setError] = useState(() => {
    const msg = sessionStorage.getItem('mdv_access_msg');
    if (msg) sessionStorage.removeItem('mdv_access_msg');
    return msg || '';
  });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const config = usePublicConfig();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email: email.trim(), password });
      localStorage.setItem('mdv_token', data.token);
      localStorage.setItem('mdv_user', JSON.stringify(data.user));
      if (data.restricted) {
        // Assinatura vencida/pendente: entra só na tela de pagamento.
        localStorage.setItem('mdv_restricted', '1');
        navigate('/assinatura');
      } else {
        localStorage.removeItem('mdv_restricted');
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao entrar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand variant="auth" />
        <p>Entre na sua conta</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label>E-mail</label>
          <input
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label>Senha</label>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />

          <div className="auth-forgot">
            <Link to="/esqueci-senha">Esqueci minha senha</Link>
          </div>

          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        {config.registrationMode !== 'closed' && (
          <p className="auth-footer">
            Não tem conta? <Link to="/registrar">Criar conta</Link>
          </p>
        )}
        {config.supportContact && <p className="auth-support">Precisa de ajuda? {config.supportContact}</p>}
      </div>
    </div>
  );
}
