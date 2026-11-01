// frontend/src/pages/TelefoneWeb.jsx
// Bancada de testes do telefone do navegador (chamadas de WhatsApp pela API Oficial da Meta).
import { useEffect, useState } from 'react';
import api from '../services/api';
import { runLoopbackTest, isWebPhoneSupported } from '../utils/webPhoneEngine';
import '../components/phone/Phone.css';

export default function TelefoneWeb() {
  const [config, setConfig] = useState(null);
  const [settings, setSettings] = useState({});
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.get('/whatsapp-calls/config').then(({ data }) => setConfig(data)).catch(() => setConfig({ connections: [], iceServers: [] }));
  }, []);

  async function runTest() {
    setTesting(true);
    setTest(null);
    setTest(await runLoopbackTest(config?.iceServers || []));
    setTesting(false);
  }

  async function checkSettings(connection) {
    setMessage('');
    try {
      const { data } = await api.get(`/whatsapp-calls/connections/${connection.id}/settings`);
      setSettings((s) => ({ ...s, [connection.id]: data }));
    } catch (error) {
      setMessage(error.response?.data?.error || 'Não consegui consultar a Meta.');
    }
  }

  async function enable(connection) {
    setMessage('');
    try {
      await api.post(`/whatsapp-calls/connections/${connection.id}/enable`, { enabled: true });
      setMessage('✅ Chamadas ativadas neste número.');
      checkSettings(connection);
    } catch (error) {
      setMessage(error.response?.data?.error || 'A Meta recusou ativar as chamadas.');
    }
  }

  return (
    <div className="page">
      <h1>📞 Telefone do WhatsApp</h1>
      <p>
        Chamadas de voz do WhatsApp feitas e recebidas aqui no navegador. Funcionam <strong>só com números da API Oficial da Meta</strong>{' '}
        (cadastrados em Conexões). O WhatsApp conectado por QR Code não faz chamadas.
      </p>

      <div className="card">
        <h3>1. Testar o telefone deste computador</h3>
        <p>Liga duas pontas dentro desta página e confere microfone, formato de áudio e rede. Não precisa de conta na Meta.</p>
        {!isWebPhoneSupported() && <p className="chat-warning">Este navegador não suporta chamadas. Use Chrome, Edge ou Safari atualizado, em https.</p>}
        <button type="button" className="btn-primary" onClick={runTest} disabled={testing}>{testing ? 'Testando (≈ 5s)…' : 'Testar microfone e conexão'}</button>
        {test && (
          <>
            <ul className="phone-test-steps">
              {test.steps.map((s) => (
                <li key={s.name}>{s.ok ? '✅' : '❌'} {s.name}{s.detail && <small>{s.detail}</small>}</li>
              ))}
            </ul>
            <p><strong>{test.ok ? 'Tudo certo: este navegador está pronto para ligar.' : 'Há algo a corrigir (veja os itens com ❌).'}</strong></p>
          </>
        )}
      </div>

      <div className="card">
        <h3>2. Números da API Oficial</h3>
        {config && config.connections.length === 0 && (
          <p>Nenhuma conexão da API Oficial cadastrada. Cadastre em <a href="/conexoes">Conexões</a>.</p>
        )}
        {config?.connections.map((c) => (
          <div key={c.id} style={{ marginBottom: 12 }}>
            <strong>{c.instanceName}</strong> <small>{c.phone}</small>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn-outline btn-small" onClick={() => checkSettings(c)}>Ver se as chamadas estão ativas</button>
              <button type="button" className="btn-outline btn-small" onClick={() => enable(c)}>Ativar chamadas neste número</button>
            </div>
            {settings[c.id] && (
              <pre style={{ fontSize: 12, background: '#f9fafb', padding: 8, borderRadius: 8, overflow: 'auto' }}>
                {JSON.stringify(settings[c.id], null, 2)}
              </pre>
            )}
          </div>
        ))}
        {message && <p>{message}</p>}
        <p style={{ fontSize: 13, color: '#6b7280' }}>
          Para ligar: abra o Chat, escolha o contato e use o botão <strong>📞 WhatsApp</strong>. Para receber: assine o campo
          <strong> calls</strong> no webhook da Meta (veja o guia).
        </p>
      </div>
    </div>
  );
}
