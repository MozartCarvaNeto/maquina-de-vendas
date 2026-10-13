// frontend/src/components/ChatMedia.jsx
// Mostra o anexo de uma mensagem do Chat (foto, vídeo, áudio ou documento).
// O arquivo é privado: é baixado com o login (token) e exibido via blob.
import { useState, useEffect } from 'react';
import api from '../services/api';
import { formatBytes } from '../utils/attachments';

function useMediaUrl(messageId, auto) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function load() {
    if (url || loading) return url;
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get(`/whatsapp/messages/${messageId}/media`, { responseType: 'blob' });
      const objectUrl = URL.createObjectURL(data);
      setUrl(objectUrl);
      return objectUrl;
    } catch {
      setError(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (auto) load();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, auto]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return { url, loading, error, load };
}

function downloadBlobUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'arquivo';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ChatMedia({ message }) {
  const type = message.mediaType;
  const auto = type === 'image' || type === 'audio';
  const { url, loading, error, load } = useMediaUrl(message.id, auto);
  const [viewerOpen, setViewerOpen] = useState(false);

  if (!type) return null;

  if (error) {
    return <div className="chat-media-error">⚠️ Não foi possível carregar o arquivo. <button type="button" className="btn-link-small" onClick={load}>tentar de novo</button></div>;
  }

  if (type === 'image') {
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" title="Abrir em tamanho real">
        <img className="chat-media-image" src={url} alt={message.mediaName || 'foto'} />
      </a>
    ) : (
      <div className="chat-media-placeholder">{loading ? 'Carregando foto…' : '🖼️'}</div>
    );
  }

  if (type === 'audio') {
    return url ? <audio className="chat-media-audio" controls src={url} /> : <div className="chat-media-placeholder">{loading ? 'Carregando áudio…' : '🎤'}</div>;
  }

  if (type === 'video') {
    return url ? (
      <video className="chat-media-video" controls src={url} />
    ) : (
      <button type="button" className="chat-media-file" onClick={load} disabled={loading}>
        <span className="chat-media-icon">🎥</span>
        <span className="chat-media-meta"><strong>{message.mediaName || 'Vídeo'}</strong><small>{loading ? 'Carregando…' : `Tocar vídeo ${formatBytes(message.mediaSize)}`}</small></span>
      </button>
    );
  }

  // documento
  const isPdf = /pdf/i.test(message.mediaMime || '') || /\.pdf$/i.test(message.mediaName || '');

  async function handleDownload() {
    const target = url || (await load());
    if (target) downloadBlobUrl(target, message.mediaName);
  }

  // PDF abre aqui mesmo, numa janela dentro do sistema (sem precisar baixar).
  async function handleOpen() {
    const target = url || (await load());
    if (target) setViewerOpen(true);
  }

  return (
    <>
      <div className="chat-media-file chat-media-doc">
        <span className="chat-media-icon">{isPdf ? '📕' : '📄'}</span>
        <span className="chat-media-meta">
          <strong>{message.mediaName || 'Documento'}</strong>
          <small>{loading ? 'Carregando…' : formatBytes(message.mediaSize)}</small>
        </span>
        <span className="chat-media-actions">
          {isPdf && (
            <button type="button" className="chat-media-btn" onClick={handleOpen} disabled={loading}>Abrir</button>
          )}
          <button type="button" className="chat-media-btn" onClick={handleDownload} disabled={loading}>Baixar</button>
        </span>
      </div>

      {viewerOpen && url && (
        <div className="chat-viewer-overlay" onClick={() => setViewerOpen(false)}>
          <div className="chat-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="chat-viewer-bar">
              <strong>{message.mediaName || 'Documento'}</strong>
              <span>
                <a href={url} target="_blank" rel="noreferrer">Abrir em nova aba</a>
                <button type="button" className="chat-media-btn" onClick={handleDownload}>Baixar</button>
                <button type="button" className="chat-media-btn" onClick={() => setViewerOpen(false)} aria-label="Fechar">✕</button>
              </span>
            </div>
            <iframe className="chat-viewer-frame" title={message.mediaName || 'Documento'} src={url} />
          </div>
        </div>
      )}
    </>
  );
}
