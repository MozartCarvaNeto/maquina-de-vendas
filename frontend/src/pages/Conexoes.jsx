// frontend/src/pages/Conexoes.jsx
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import './Conexoes.css';

export default function Conexoes() {
  const [connections, setConnections] = useState([]);
  const [newInstanceName, setNewInstanceName] = useState('');
  const [qrModal, setQrModal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('native');
  const [cloudForm, setCloudForm] = useState({ instanceName: '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' });
  const [cloudResult, setCloudResult] = useState(null);
  const [editingTokenFor, setEditingTokenFor] = useState(null);
  const [tokenDraft, setTokenDraft] = useState('');

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  const loadConnections = useCallback(async () => {
    const { data } = await api.get('/whatsapp/connections');
    setConnections(data.connections);
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    if (!socket) return undefined;

    const handleQr = ({ connectionId, qr }) => {
      setQrModal((prev) => {
        if (!prev || prev.connectionId !== connectionId) return prev;
        return { ...prev, qr, status: 'pendente', message: null };
      });
    };

    const handleStatus = ({ connectionId, status, phone, message }) => {
      setConnections((prev) =>
        prev.map((c) => (c.id === connectionId ? { ...c, status, phone: phone || c.phone } : c))
      );

      setQrModal((prev) => {
        if (!prev || prev.connectionId !== connectionId) return prev;
        if (status === 'conectado') return null;
        return { ...prev, status, message: message || null };
      });
    };

    socket.on('whatsapp:qr', handleQr);
    socket.on('whatsapp:status', handleStatus);

    return () => {
      socket.off('whatsapp:qr', handleQr);
      socket.off('whatsapp:status', handleStatus);
    };
  }, [socket]);

  async function handleCreateConnection(e) {
    e.preventDefault();
    if (!newInstanceName.trim()) return;

    setLoading(true);
    try {
      const { data } = await api.post('/whatsapp/connections', { instanceName: newInstanceName });
      setNewInstanceName('');
      setQrModal({ connectionId: data.connection.id, qr: null, status: 'pendente', message: null });
      loadConnections();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar conexão');
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckStatus(connectionId) {
    const { data } = await api.get(`/whatsapp/connections/${connectionId}/status`);
    setConnections((prev) => prev.map((c) => (c.id === connectionId ? data.connection : c)));
  }

  async function handleReconnect(connectionId) {
    try {
      await api.post(`/whatsapp/connections/${connectionId}/reconnect`);
      setQrModal({ connectionId, qr: null, status: 'pendente', message: null });
      loadConnections();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao reconectar');
    }
  }

  async function handleDelete(connectionId) {
    if (!window.confirm('Remover esta conexão? O aparelho precisará escanear o QR de novo se você conectar novamente.')) return;
    await api.delete(`/whatsapp/connections/${connectionId}`);
    loadConnections();
  }

  const connectedCount = connections.filter((c) => c.status === 'conectado').length;

  async function handleCreateCloudConnection(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/whatsapp-cloud', cloudForm);
      setCloudResult({ webhookUrl: data.webhookUrl, verifyToken: data.connection.webhookVerifyToken });
      setCloudForm({ instanceName: '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' });
      loadConnections();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao conectar com a API da Meta');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateToken(connectionId) {
    if (!tokenDraft.trim()) return;
    try {
      await api.patch(`/whatsapp-cloud/${connectionId}`, { accessToken: tokenDraft });
      setEditingTokenFor(null);
      setTokenDraft('');
      loadConnections();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao atualizar o token');
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard?.writeText(text);
  }

  return (
    <div className="conexoes-page">
      <header>
        <h1>Conexões WhatsApp</h1>
        <p>Conecte até 10 aparelhos diferentes escaneando o QR Code — conexão nativa, sem depender de nenhum serviço externo.</p>
      </header>

      {connectedCount > 0 && (
        <div className="conexoes-next-step">
          <div>
            <strong>✅ {connectedCount} número(s) conectado(s)</strong>
            <p>Agora você já pode conversar em tempo real ou enviar mensagens em massa revezando entre os números.</p>
          </div>
          <div className="conexoes-next-step-actions">
            <Link to="/chat" className="btn-outline">💬 Ir para o Chat</Link>
            <Link to="/disparos" className="btn-primary">📣 Enviar mensagens em massa</Link>
          </div>
        </div>
      )}

      <div className="conexoes-mode-switch">
        <button className={mode === 'native' ? 'active' : ''} onClick={() => setMode('native')}>
          📱 QR Code
          <small>Escaneia com o WhatsApp do celular — grátis, sem cadastro na Meta</small>
        </button>
        <button className={mode === 'cloud' ? 'active' : ''} onClick={() => setMode('cloud')}>
          🔌 API Oficial (Meta)
          <small>Número verificado pela Meta — precisa de conta de desenvolvedor</small>
        </button>
      </div>

      {mode === 'native' && (
        <>
          <form className="conexoes-new-form" onSubmit={handleCreateConnection}>
            <input
              placeholder="Nome da conexão (ex: vendas-principal)"
              value={newInstanceName}
              onChange={(e) => setNewInstanceName(e.target.value)}
            />
            <button className="btn-primary" disabled={loading || connections.length >= 10}>
              {loading ? 'Iniciando...' : '📱 Conectar WhatsApp'}
            </button>
          </form>
          {connections.length >= 10 && <p className="hint-text">Limite de 10 conexões atingido.</p>}
        </>
      )}

      {mode === 'cloud' && (
        <div className="conexoes-cloud-panel">
          <details className="conexoes-cloud-howto">
            <summary>Como conseguir os dados abaixo (passo a passo na Meta)</summary>
            <ol>
              <li>Acesse <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a> e crie um app do tipo "Negócios".</li>
              <li>No app, adicione o produto <strong>WhatsApp</strong>.</li>
              <li>Em WhatsApp → Introdução, anote o <strong>Phone number ID</strong> e o <strong>WhatsApp Business Account ID</strong>.</li>
              <li>Gere um <strong>token de acesso permanente</strong>: Configurações do app → Usuários do sistema → crie um usuário do sistema → gere o token com a permissão <code>whatsapp_business_messaging</code>.</li>
              <li>Em Configurações do app → Básico, copie o <strong>App Secret</strong> (opcional, mas recomendado).</li>
              <li>Preencha o formulário abaixo e clique em Conectar — você vai receber a URL do webhook e o código de verificação pra colar de volta na Meta.</li>
              <li>Na Meta, em WhatsApp → Configuração, cole a URL do webhook e o código de verificação, e clique em Verificar e salvar. Depois, inscreva-se no campo <code>messages</code>.</li>
            </ol>
          </details>

          <form className="conexoes-cloud-form" onSubmit={handleCreateCloudConnection}>
            <input placeholder="Nome da conexão (ex: vendas-oficial)" value={cloudForm.instanceName} onChange={(e) => setCloudForm({ ...cloudForm, instanceName: e.target.value })} required />
            <input placeholder="Phone Number ID" value={cloudForm.phoneNumberId} onChange={(e) => setCloudForm({ ...cloudForm, phoneNumberId: e.target.value })} required />
            <input placeholder="WhatsApp Business Account ID (opcional)" value={cloudForm.wabaId} onChange={(e) => setCloudForm({ ...cloudForm, wabaId: e.target.value })} />
            <input placeholder="Token de acesso permanente" type="password" value={cloudForm.accessToken} onChange={(e) => setCloudForm({ ...cloudForm, accessToken: e.target.value })} required />
            <input placeholder="App Secret (opcional, recomendado)" type="password" value={cloudForm.appSecret} onChange={(e) => setCloudForm({ ...cloudForm, appSecret: e.target.value })} />
            <button className="btn-primary" disabled={loading}>{loading ? 'Conectando...' : '🔌 Conectar com a API da Meta'}</button>
          </form>

          {cloudResult && (
            <div className="conexoes-cloud-result">
              <p>✅ Conectado! Agora cole estes dois valores no painel da Meta (WhatsApp → Configuração → Webhook):</p>
              <div className="conexoes-cloud-copy-row">
                <label>URL de retorno de chamada</label>
                <div><code>{cloudResult.webhookUrl}</code><button type="button" onClick={() => copyToClipboard(cloudResult.webhookUrl)}>Copiar</button></div>
              </div>
              <div className="conexoes-cloud-copy-row">
                <label>Verificar token</label>
                <div><code>{cloudResult.verifyToken}</code><button type="button" onClick={() => copyToClipboard(cloudResult.verifyToken)}>Copiar</button></div>
              </div>
              <p className="hint-text">Depois de colar e clicar em "Verificar e salvar" na Meta, não esqueça de clicar em "Inscrever-se" no campo <code>messages</code>, ou as respostas dos leads não vão chegar aqui.</p>
            </div>
          )}
        </div>
      )}

      <div className="connections-list">
        {connections.map((conn) => (
          <div className="connection-item" key={conn.id}>
            <div>
              <strong>{conn.instanceName}</strong>
              {' '}
              <span className="connection-tag">{conn.provider === 'cloud_api' ? '🔌 API Oficial' : '📱 QR Code'}</span>
              <span className="phone">{conn.phone || 'Aguardando conexão'}</span>
            </div>
            <span className={`status-badge ${conn.status === 'conectado' ? 'connected' : 'disconnected'}`}>
              {conn.status.toUpperCase()}
            </span>
            <div className="connection-actions">
              {conn.provider === 'cloud_api' ? (
                editingTokenFor === conn.id ? (
                  <>
                    <input className="connection-token-input" type="password" placeholder="Novo token de acesso" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} />
                    <button className="btn-outline" onClick={() => handleUpdateToken(conn.id)}>Salvar</button>
                    <button className="btn-outline" onClick={() => setEditingTokenFor(null)}>Cancelar</button>
                  </>
                ) : (
                  <button className="btn-outline" onClick={() => { setEditingTokenFor(conn.id); setTokenDraft(''); }}>
                    Atualizar token
                  </button>
                )
              ) : (
                conn.status !== 'conectado' && (
                  <>
                    <button className="btn-outline" onClick={() => setQrModal({ connectionId: conn.id, qr: null, status: conn.status, message: null })}>
                      Ver QR Code
                    </button>
                    <button className="btn-outline" onClick={() => handleReconnect(conn.id)}>
                      Gerar novo QR
                    </button>
                  </>
                )
              )}
              <button className="btn-outline" onClick={() => handleCheckStatus(conn.id)}>Atualizar status</button>
              <button className="btn-danger" onClick={() => handleDelete(conn.id)}>Excluir</button>
            </div>
          </div>
        ))}
        {connections.length === 0 && <p className="empty-state">Nenhuma conexão criada ainda</p>}
      </div>

      {qrModal && (
        <div className="modal-overlay" onClick={() => setQrModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Escaneie o QR Code</h2>
            <p>Abra o WhatsApp no celular → Configurações → Aparelhos conectados → Conectar um aparelho.</p>
            {qrModal.status === 'erro' ? (
              <div className="qr-error">
                <p>⚠️ {qrModal.message || 'Não foi possível gerar o QR Code.'}</p>
                <button className="btn-primary" onClick={() => handleReconnect(qrModal.connectionId)}>
                  Tentar novamente
                </button>
              </div>
            ) : qrModal.qr ? (
              <img src={qrModal.qr} alt="QR Code WhatsApp" className="qr-image" />
            ) : (
              <p className="qr-loading">
                {qrModal.message || 'Gerando QR Code... (pode levar até 15 segundos)'}
              </p>
            )}
            <button className="btn-outline" onClick={() => setQrModal(null)}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}