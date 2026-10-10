// frontend/src/pages/ForgotPassword.jsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import usePublicConfig from '../hooks/usePublicConfig';
import Brand from '../components/brand/Brand';
import './Auth.css';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const config = usePublicConfig();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email: email.trim() });
      setMessage(data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao solicitar redefinição');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand variant="auth" />
        <p>Esqueci minha senha</p>

        {error && <div className="auth-error">{error}</div>}
        {message && <div className="auth-success">{message}</div>}

        {!message && (
          <form onSubmit={handleSubmit}>
            <label>Seu e-mail de login</label>
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

            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? 'Enviando...' : 'Enviar link para criar nova senha'}
            </button>
          </form>
        )}

        {message && (
          <p className="auth-support">
            Não chegou em alguns minutos? Veja a caixa de spam
            {config.supportContact ? ` ou fale com o suporte: ${config.supportContact}` : ' ou peça ao administrador da sua conta para gerar uma nova senha'}.
          </p>
        )}

        <p className="auth-footer">
          <Link to="/login">Voltar para o login</Link>
        </p>
      </div>
    </div>
  );
}
