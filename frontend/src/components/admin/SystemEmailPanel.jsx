// frontend/src/components/admin/SystemEmailPanel.jsx
// Teste do e-mail do sistema (recuperação de senha e avisos): mostra qual caminho funcionou ou o erro de cada um.
import { useState } from 'react';
import api from '../../services/api';

export default function SystemEmailPanel() {
  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const [to, setTo] = useState(currentUser.email || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function runTest(e) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const { data } = await api.post('/admin/system-email/test', { to }, { timeout: 60000 });
      setResult(data);
    } catch (error) {
      setResult({ ok: false, error: error.response?.data?.error || 'Não foi possível testar.', attempts: [] });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h3>✉️ E-mail do sistema (recuperar senha e avisos)</h3>
      <p>
        É por aqui que sai o link de "Esqueci minha senha" de <strong>todos os clientes</strong>. O sistema tenta, em ordem:
        (1) o SMTP do sistema no <code>.env</code> (<code>SYSTEM_SMTP_*</code>); (2) o e-mail da conta do cliente; (3) o e-mail
        configurado na <strong>sua conta de administrador</strong> (Configurações → E-mail). Configure pelo menos o (1) ou o (3).
      </p>
      <form onSubmit={runTest} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="email" required placeholder="E-mail que vai receber o teste" value={to} onChange={(e) => setTo(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn-primary" type="submit" disabled={loading}>{loading ? 'Enviando…' : 'Enviar e-mail de teste'}</button>
      </form>

      {result && (
        <div style={{ marginTop: 16 }}>
          <p><strong>{result.ok ? '✅ O teste foi enviado. Confira a caixa de entrada e o spam.' : '❌ Nenhum caminho conseguiu enviar o e-mail.'}</strong></p>
          <ul>
            {(result.attempts || []).map((a, i) => (
              <li key={i}>{a.ok ? '✅' : '❌'} {a.via}{a.error ? ` — ${a.error}` : ''}</li>
            ))}
          </ul>
          {result.frontendUrlLooksLocal && (
            <p className="chat-warning">⚠️ <code>FRONTEND_URL</code> no .env está como <code>{result.frontendUrl}</code>. Os links dos e-mails vão apontar para o seu computador. Troque pelo endereço real do sistema (https://…).</p>
          )}
          {!result.ok && (
            <p style={{ fontSize: 13 }}>
              Dica: em Configurações → E-mail da sua conta, configure um provedor (SMTP, Resend, SendGrid ou Twilio E-mail) e use o botão de teste de lá.
              Ou coloque no <code>.env</code> do servidor: <code>SYSTEM_SMTP_HOST</code>, <code>SYSTEM_SMTP_PORT</code>, <code>SYSTEM_SMTP_USER</code>, <code>SYSTEM_SMTP_PASS</code> e <code>SYSTEM_MAIL_FROM</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
