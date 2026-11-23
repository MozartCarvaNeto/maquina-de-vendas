// Administração > Vídeos tutoriais: um link do YouTube por página do sistema.
import { useState, useEffect } from 'react';
import api from '../../services/api';
import { TUTORIAL_PAGES, thumbUrl } from '../layout/tutorialPages';
import { reloadTutorials } from '../layout/VideoHelp';
import '../account/Account.css';

function Row({ page, saved, onChange }) {
  const [url, setUrl] = useState(saved?.url || '');
  const [title, setTitle] = useState(saved?.title || '');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setUrl(saved?.url || ''); setTitle(saved?.title || ''); }, [saved?.url, saved?.title]);

  async function save() {
    setBusy(true); setMsg(null);
    try { const { data } = await api.put(`/admin/tutorials/${page.key}`, { url, title }); onChange(page.key, data); setMsg({ text: 'Salvo.' }); }
    catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao salvar.' }); }
    setBusy(false);
  }
  async function remove() {
    setBusy(true); setMsg(null);
    try { await api.delete(`/admin/tutorials/${page.key}`); onChange(page.key, null); setUrl(''); setTitle(''); setMsg({ text: 'Vídeo removido.' }); }
    catch (e) { setMsg({ error: true, text: e.response?.data?.error || 'Erro ao remover.' }); }
    setBusy(false);
  }
  return (
    <div className="acc-card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '0 0 128px', height: 72, background: '#e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        {saved?.videoId && <img src={thumbUrl(saved.videoId)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      </div>
      <div style={{ flex: '1 1 280px', minWidth: 0, display: 'grid', gap: 6 }}>
        <strong>{page.label}</strong>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link do YouTube (https://www.youtube.com/watch?v=...)" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nome do vídeo (aparece ao lado da miniatura)" maxLength={120} />
        <div className="acc-row">
          <button className="btn-primary" disabled={busy || !url.trim()} onClick={save}>Salvar</button>
          {saved && <button disabled={busy} onClick={remove}>Remover</button>}
          {msg && <span className={msg.error ? 'acc-msg is-error' : 'acc-muted'}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}

export default function VideosPanel() {
  const [map, setMap] = useState(null);
  useEffect(() => { reloadTutorials().then(setMap); }, []);
  function onChange(key, data) {
    setMap((m) => { const n = { ...(m || {}) }; if (data) n[key] = data; else delete n[key]; return n; });
    window.dispatchEvent(new Event('tutorials-changed'));
  }
  if (!map) return <p>Carregando…</p>;
  return (
    <section>
      <h3>🎬 Vídeos tutoriais por página</h3>
      <p className="acc-muted">Cole o link do vídeo do YouTube de cada página e o nome dele. Uma miniatura clicável aparece no topo da página para todos os usuários. Páginas sem vídeo não mostram nada. Só o administrador da plataforma altera.</p>
      {TUTORIAL_PAGES.map((p) => <Row key={p.key} page={p} saved={map[p.key]} onChange={onChange} />)}
    </section>
  );
}
