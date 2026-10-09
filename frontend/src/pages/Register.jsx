// frontend/src/pages/Register.jsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../services/api';
import PasswordInput from '../components/auth/PasswordInput';
import usePublicConfig from '../hooks/usePublicConfig';
import './Auth.css';

export default function Register() {
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const config = usePublicConfig();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', { name, companyName, email, password });
      // Cadastro aguardando aprovação do administrador: não há login ainda.
      if (data.pending) {
        setPendingMessage(data.message);
        return;
      }
      localStorage.setItem('mdv_token', data.token);
      localStorage.setItem('mdv_user', JSON.stringify(data.user));
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao criar conta');
    } finally {
      setLoading(false);
    }
  }

  if (pendingMessage) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>🚀 Máquina de Vendas</h1>
          <p>Cadastro recebido</p>
          <div className="auth-success">{pendingMessage}</div>
          <p className="auth-footer">
            <Link to="/login">Ir para o login</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>🚀 Máquina de Vendas</h1>
        <p>Crie a conta da sua empresa</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label>Seu nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />

          <label>Nome da empresa (opcional)</label>
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Se vazio, usa seu nome" />

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
          <PasswordInput
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />

          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Criando...' : 'Criar conta'}
          </button>
        </form>

        <p className="auth-footer">
          Você será cadastrado como <strong>owner</strong> (administrador principal) e depois pode convidar sua equipe pela tela Equipe.
        </p>
        <p className="auth-footer">
          Já tem conta? <Link to="/login">Entrar</Link>
        </p>
      </div>
    </div>
  );
}