// frontend/src/pages/Chat.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import './Chat.css';

export default function Chat() {
  const [conversations, setConversations] = useState([]);
  const [activeLead, setActiveLead] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedInstance, setSelectedInstance] = useState('');
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);

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
        setMessages((prev) => [...prev, message]);
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

  async function handleSend(e) {
    e.preventDefault();
    if (!inputText.trim() || !activeLead || !selectedInstance) return;

    if (!activeLead.phone) {
      alert('Este lead não tem telefone cadastrado — não é possível enviar WhatsApp.');
      return;
    }

    try {
      const { data } = await api.post('/whatsapp/messages', {
        leadId: activeLead.id,
        text: inputText,
        instanceId: selectedInstance
      });
      setMessages((prev) => [...prev, data.message]);
      setInputText('');
      loadConversations(); // atualiza a lista à esquerda, inclusive se esta era a 1ª mensagem
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao enviar mensagem');
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
            <p>{conv.messages[0]?.body?.slice(0, 40)}</p>
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

            <div className="chat-messages">
              {messages.length === 0 && (
                <p className="chat-empty-conversation">Esta é uma conversa nova — envie a primeira mensagem abaixo.</p>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`chat-bubble ${msg.direction}`}>
                  {msg.body}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <form className="chat-input-bar" onSubmit={handleSend}>
              <select value={selectedInstance} onChange={(e) => setSelectedInstance(e.target.value)} disabled={!activeLead.phone}>
                <option value="">Selecione o número</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.instanceName}</option>
                ))}
              </select>
              <input
                placeholder={activeLead.phone ? 'Digite sua mensagem...' : 'Indisponível: lead sem telefone'}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={!activeLead.phone}
              />
              <button className="btn-primary" type="submit" disabled={!activeLead.phone || !selectedInstance}>Enviar</button>
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