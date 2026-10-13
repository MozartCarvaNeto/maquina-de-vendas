// frontend/src/pages/Chat.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../services/api';
import { useSocket } from '../hooks/useSocket';
import ChatMedia from '../components/ChatMedia';
import { CHAT_ATTACHMENT_ACCEPT, normalizeChatFile, formatBytes } from '../utils/attachments';
import './Chat.css';

function previewLabel(message, aiReport) {
  if (!message) return '';
  if (message.direction === 'nota') return `📋 Relatório da IA${aiReport?.outcome ? ` — ${aiReport.outcome}` : ''}`;
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
  const [pendingVoice, setPendingVoice] = useState(false); // true = áudio gravado aqui (vai como mensagem de voz)
  const [previewUrl, setPreviewUrl] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef(null);
  const recChunksRef = useRef([]);
  const recStreamRef = useRef(null);
  const recTimerRef = useRef(null);
  const recCancelledRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [onlyAwaiting, setOnlyAwaiting] = useState(false);

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

  // Já deixa o número de WhatsApp escolhido: o mesmo que a IA usou com o contato, ou o único conectado.
  useEffect(() => {
    if (!activeLead || connections.length === 0) return;
    setSelectedInstance((current) => {
      if (current && connections.some((c) => c.id === current)) return current;
      const preferred = connections.find((c) => c.id === activeLead.lastConnectionId);
      if (preferred) return preferred.id;
      return connections.length === 1 ? connections[0].id : '';
    });
  }, [activeLead, connections]);

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
    const checked = normalizeChatFile(file);
    if (checked.error) {
      alert(checked.error);
      return;
    }
    setPendingVoice(false);
    setPendingFile(checked.file);
  }

  // Pré-visualização (foto/áudio) do arquivo que está para ser enviado.
  useEffect(() => {
    if (!pendingFile || !/^(image|audio)\//.test(pendingFile.type || '')) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  // ---------- gravação de áudio pelo microfone ----------
  async function startRecording() {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      alert('Este navegador não permite gravar áudio. Use o Chrome, Edge ou Safari atualizado (e abra o sistema em https).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
      const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recChunksRef.current = [];
      recCancelledRef.current = false;
      recorder.ondataavailable = (ev) => { if (ev.data?.size) recChunksRef.current.push(ev.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(recTimerRef.current);
        setRecording(false);
        if (recCancelledRef.current || recChunksRef.current.length === 0) return;
        const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(recChunksRef.current, { type: recorder.mimeType || type });
        setPendingFile(new File([blob], `audio-${Date.now()}.${ext}`, { type }));
        setPendingVoice(true);
      };
      recorderRef.current = recorder;
      recStreamRef.current = stream;
      recorder.start();
      setRecSeconds(0);
      setRecording(true);
      recTimerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (error) {
      alert(error?.name === 'NotAllowedError'
        ? 'O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço do site e permita o microfone.'
        : 'Não foi possível acessar o microfone.');
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }

  function cancelRecording() {
    recCancelledRef.current = true;
    stopRecording();
  }

  // Ao sair da conversa/página, solta o microfone.
  useEffect(() => () => {
    recCancelledRef.current = true;
    clearInterval(recTimerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

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
        if (pendingVoice) payload.append('voice', '1');
      } else {
        payload = { leadId: activeLead.id, text: inputText, instanceId: selectedInstance };
      }
      const { data } = await api.post('/whatsapp/messages', payload, { timeout: 120000 });
      setMessages((prev) => (prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]));
      setInputText('');
      setPendingFile(null);
      setPendingVoice(false);
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
        {conversations.some((c) => c.aiReport) && (
          <div className="chat-filter-chips">
            <button type="button" className={!onlyAwaiting ? 'active' : ''} onClick={() => setOnlyAwaiting(false)}>Todas</button>
            <button type="button" className={onlyAwaiting ? 'active' : ''} onClick={() => setOnlyAwaiting(true)}>
              🔥 Aguardando você ({conversations.filter((c) => c.aiReport?.awaitingSeller).length})
            </button>
          </div>
        )}
        {conversations
          .filter((conv) => !onlyAwaiting || conv.aiReport?.awaitingSeller)
          .map((conv) => (
          <div
            key={conv.id}
            className={`chat-conv-item ${activeLead?.id === conv.id ? 'active' : ''} ${conv.aiReport?.awaitingSeller ? 'awaiting' : ''}`}
            onClick={() => openConversation(conv.id)}
          >
            <strong>{conv.name}</strong>
            {conv.phone && <span className="chat-conv-phone">{conv.phone}</span>}
            {conv.aiReport?.awaitingSeller && (
              <span className="chat-conv-badge">🔥 Aguardando seu retorno{conv.aiReport.isTest ? ' (teste)' : ''}</span>
            )}
            <p>{previewLabel(conv.messages[0], conv.aiReport).slice(0, 48)}</p>
          </div>
        ))}
        {onlyAwaiting && !conversations.some((c) => c.aiReport?.awaitingSeller) && (
          <p className="empty-state">Ninguém aguardando retorno agora. 🎉</p>
        )}
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

            {(() => {
              const latestNote = [...messages].reverse().find((m) => m.direction === 'nota');
              return latestNote ? (
                <details className="chat-report-pin">
                  <summary>📋 Relatório da última ligação da IA — clique para ver / esconder</summary>
                  <pre>{latestNote.body}</pre>
                </details>
              ) : null;
            })()}

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
                <span>
                  {pendingFile.type.startsWith('image/') ? '🖼️' : pendingFile.type.startsWith('audio/') ? '🎤' : '📎'}{' '}
                  <strong>{pendingVoice ? 'Mensagem de voz' : pendingFile.name}</strong> ({formatBytes(pendingFile.size)})
                </span>
                {previewUrl && pendingFile.type.startsWith('audio/') && <audio className="chat-pending-audio" controls src={previewUrl} />}
                {previewUrl && pendingFile.type.startsWith('image/') && <img className="chat-pending-thumb" src={previewUrl} alt="pré-visualização" />}
                <button type="button" className="btn-link-small" onClick={() => { setPendingFile(null); setPendingVoice(false); }}>remover</button>
              </div>
            )}
            {recording && (
              <div className="chat-recording-bar">
                <span className="chat-rec-dot" /> Gravando… {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
                <button type="button" className="btn-primary" onClick={stopRecording}>⏹ Parar</button>
                <button type="button" className="btn-link-small" onClick={cancelRecording}>cancelar</button>
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
                accept={CHAT_ATTACHMENT_ACCEPT}
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
              <button
                type="button"
                className="chat-attach-btn"
                title="Gravar mensagem de voz"
                aria-label="Gravar áudio"
                disabled={!activeLead.phone || recording || !!pendingFile}
                onClick={startRecording}
              >
                🎤
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