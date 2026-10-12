// frontend/src/pages/Chat.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import ChatMedia from '../components/ChatMedia';
import { ATTACHMENT_REGEX, BLOCKED_EXT_REGEX, ATTACHMENT_ACCEPT, formatBytes } from '../utils/attachments';
import './Chat.css';

function previewLabel(message) {
  if (!message) return '';
  if (message.direction === 'nota') return '📋 Relatório da ligação (IA)';
  if (message.body) return message.body;
  const labels = { image: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio' };
  if (message.mediaType === 'document') return `📄 ${message.mediaName || 'Documento'}`;
  return labels[message.mediaType] || '';
}

export default function Chat() {
  const [conversations, setConversations] = useState([]);
  const [activeLead, setActiveLead] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedInstance, setSelectedInstance] = useState('');
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [sending, setSending] = useState(false);

  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [leadSearch, setLeadSearch] = useState('');
  const [leadResults, setLeadResults] = useState([]);

  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  const loadConversations = useCallback(async () => {
    const { data } = await api.get('/whatsapp/conversations');
    setConversations(data.conversations);
  }, []);

  const loadConnections = useCallback(async () => {
    const { data } = await api.get('/whatsapp/connections');
    setConnections(data.connections.filter((c) => c.status === 'conectado'));
  }, []);

  useEffect(() => {
    loadConversations();
    loadConnections();
  }, [loadConversations, loadConnections]);

  async function openConversation(leadId) {
    const { data } = await api.get(`/whatsapp/conversations/${leadId}`);
    setActiveLead(data.lead);
    setMessages(data.messages);
  }

  useEffect(() => {
    if (!socket) return undefined;

    let reloadTimer = null;

    const handleIncoming = ({ leadId, message }) => {
      if (activeLead && leadId === activeLead.id) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      }
      // Várias mensagens em sequência geram uma única recarga da lista
      // (antes cada mensagem baixava todas as conversas de novo).
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        loadConversations().catch(() => null);
      }, 3000);
    };

    socket.on('whatsapp:message', handleIncoming);
    return () => {
      socket.off('whatsapp:message', handleIncoming);
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [socket, activeLead, loadConversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const MAX_FILE_BYTES = 100 * 1024 * 1024;

  function pickFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      alert('O arquivo ultrapassa o limite de 100 MB do WhatsApp.');
      return;
    }
    if (!ATTACHMENT_REGEX.test(file.type || '') || BLOCKED_EXT_REGEX.test(file.name || '')) {
      alert('Formato não permitido. Envie foto (JPG, PNG, WebP), vídeo MP4, PDF, Word, Excel, PowerPoint, TXT, CSV ou ZIP.');
      return;
    }
    setPendingFile(file);
  }

  function handlePaste(e) {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      const blob = item.getAsFile();
      pickFile(new File([blob], `imagem-${Date.now()}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: blob.type }));
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    pickFile(e.dataTransfer?.files?.[0]);
  }

  async function handleSend(e) {
    e.preventDefault();
    if ((!inputText.trim() && !pendingFile) || !activeLead || !selectedInstance || sending) return;

    if (!activeLead.phone) {
      alert('Este lead não tem telefone cadastrado — não é possível enviar WhatsApp.');
      return;
    }

    setSending(true);
    try {
      let payload;
      if (pendingFile) {
        payload = new FormData();
        payload.append('leadId', activeLead.id);
        payload.append('instanceId', selectedInstance);
        payload.append('text', inputText);
        payload.append('file', pendingFile);
      } else {
        payload = { leadId: activeLead.id, text: inputText, instanceId: selectedInstance };
      }
      const { data } = await api.post('/whatsapp/messages', payload, { timeout: 120000 });
      setMessages((prev) => (prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]));
      setInputText('');
      setPendingFile(null);
      loadConversations(); // atualiza a lista à esquerda, inclusive se esta era a 1ª mensagem
    } catch (error) {
      const resp = error.response;
      let msg = resp?.data?.error;
      if (!msg) {
        if (resp?.status === 413) msg = 'O servidor recusou o arquivo por ser grande demais (limite de upload do nginx/Caddy). Aumente o limite no servidor — veja o guia.';
        else if (resp?.status === 502 || resp?.status === 504) msg = 'O servidor não respondeu a tempo (erro ' + resp.status + '). Veja os logs do sistema no servidor.';
        else if (resp) msg = 'Erro ' + resp.status + ' do servidor ao enviar. Veja os logs no servidor.';
        else if (error.code === 'ECONNABORTED') msg = 'O envio demorou demais. Tente um arquivo menor.';
        else msg = 'A conexão com o servidor foi interrompida ao enviar o arquivo (provável limite de tamanho do servidor ou queda de rede).';
      }
      alert(msg);
    } finally {
      setSending(false);
    }
  }

  // ==================== NOVA CONVERSA ====================

  async function searchLeads(term) {
    setLeadSearch(term);
    if (!term.trim()) {
      setLeadResults([]);
      return;
    }
    const { data } = await api.get('/leads', { params: { search: term, pageSize: 10 } });
    setLeadResults(data.leads.filter((l) => l.phone));
  }

  function startNewConversation(lead) {
    setActiveLead(lead);
    setMessages([]);
    setShowNewChatModal(false);
    setLeadSearch('');
    setLeadResults([]);
  }

  return (
    <div className={`chat-page ${activeLead ? 'has-active' : ''}`}>
      <aside className="chat-conversations">
        <div className="chat-conversations-header">
          <h2>Conversas</h2>
          <button className="btn-outline btn-small" onClick={() => setShowNewChatModal(true)}>➕ Nova</button>
        </div>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`chat-conv-item ${activeLead?.id === conv.id ? 'active' : ''}`}
            onClick={() => openConversation(conv.id)}
          >
            <strong>{conv.name}</strong>
            <p>{previewLabel(conv.messages[0]).slice(0, 40)}</p>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="empty-state">
            Nenhuma conversa ainda. Clique em "➕ Nova" para escrever para um contato.
          </p>
        )}
      </aside>

      <section className="chat-area">
        {!activeLead ? (
          <div className="chat-placeholder">Selecione uma conversa ou clique em "➕ Nova"</div>
        ) : (
          <>
            <header className="chat-area-header">
              <button type="button" className="chat-back-btn" onClick={() => setActiveLead(null)} aria-label="Voltar para as conversas">
                ←
              </button>
              <strong>{activeLead.name}</strong>
              <span>{activeLead.phone || 'Sem telefone cadastrado'}</span>
            </header>

            {!activeLead.phone && (
              <div className="chat-warning">
                ⚠️ Este lead não tem telefone válido — não é possível enviar mensagens por WhatsApp para ele.
                Verifique o cadastro em Contatos.
              </div>
            )}
            {connections.length === 0 && (
              <div className="chat-warning">
                ⚠️ Nenhum número de WhatsApp conectado. Conecte um em <a href="/conexoes">Conexões</a>.
              </div>
            )}

            <div className="chat-messages" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
              {messages.length === 0 && (
                <p className="chat-empty-conversation">Esta é uma conversa nova — envie a primeira mensagem abaixo.</p>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`chat-bubble ${msg.direction}${msg.mediaType ? ' has-media' : ''}`}>
                  {msg.mediaType && <ChatMedia message={msg} />}
                  {msg.direction === 'nota' && <div className="chat-note-label">📌 Nota interna — só a equipe vê (não foi enviada ao cliente)</div>}
                  {msg.body && <div className="chat-bubble-text">{msg.body}</div>}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {pendingFile && (
              <div className="chat-pending-file">
                <span>{pendingFile.type.startsWith('image/') ? '🖼️' : '📎'} <strong>{pendingFile.name}</strong> ({formatBytes(pendingFile.size)})</span>
                <button type="button" className="btn-link-small" onClick={() => setPendingFile(null)}>remover</button>
              </div>
            )}
            <form className="chat-input-bar" onSubmit={handleSend}>
              <select value={selectedInstance} onChange={(e) => setSelectedInstance(e.target.value)} disabled={!activeLead.phone}>
                <option value="">Selecione o número</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.instanceName}</option>
                ))}
              </select>
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                style={{ display: 'none' }}
                onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <button
                type="button"
                className="chat-attach-btn"
                title="Anexar foto, vídeo ou documento"
                aria-label="Anexar arquivo"
                disabled={!activeLead.phone}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
              <input
                placeholder={
                  !activeLead.phone ? 'Indisponível: lead sem telefone' : pendingFile ? 'Legenda (opcional)...' : 'Digite sua mensagem...'
                }
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPaste={handlePaste}
                disabled={!activeLead.phone}
              />
              <button className="btn-primary" type="submit" disabled={!activeLead.phone || !selectedInstance || sending}>
                {sending ? 'Enviando…' : 'Enviar'}
              </button>
            </form>
          </>
        )}
      </section>

      {showNewChatModal && (
        <div className="modal-overlay" onClick={() => setShowNewChatModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Nova conversa</h2>
            <label>Buscar contato (nome ou telefone)</label>
            <input autoFocus value={leadSearch} onChange={(e) => searchLeads(e.target.value)} placeholder="Digite para buscar..." />

            <div className="lead-search-results">
              {leadResults.map((lead) => (
                <div key={lead.id} className="lead-search-item" onClick={() => startNewConversation(lead)}>
                  <strong>{lead.name}</strong>
                  <span>{lead.phone}</span>
                </div>
              ))}
              {leadSearch && leadResults.length === 0 && (
                <p className="secondary-text">Nenhum contato com telefone encontrado.</p>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn-outline" onClick={() => setShowNewChatModal(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}