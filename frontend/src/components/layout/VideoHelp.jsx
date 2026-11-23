// Miniatura fixa do vídeo tutorial da página atual (configurada em Administração > Vídeos tutoriais).
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';
import { pageKeyFromPath, thumbUrl } from './tutorialPages';
import './VideoHelp.css';

let cache = null;
let inflight = null;
export function reloadTutorials() {
  inflight = api.get('/tutorials').then((r) => { cache = r.data || {}; return cache; }).catch(() => cache || {});
  return inflight;
}

export default function VideoHelp() {
  const { pathname } = useLocation();
  const [map, setMap] = useState(cache);
  const [open, setOpen] = useState(false);
  const isAdmin = (() => { try { return !!JSON.parse(localStorage.getItem('mdv_user') || '{}').isPlatformAdmin; } catch (_) { return false; } })();

  useEffect(() => {
    if (cache) setMap(cache);
    (inflight && !cache ? inflight : reloadTutorials()).then(setMap);
    const h = () => reloadTutorials().then(setMap);
    window.addEventListener('tutorials-changed', h);
    return () => window.removeEventListener('tutorials-changed', h);
  }, [pathname]);

  useEffect(() => { setOpen(false); }, [pathname]);

  const key = pageKeyFromPath(pathname);
  const v = map && map[key];
  if (!v) {
    if (!isAdmin || !map || key === 'admin') return null;
    return <div className="vh-empty">🎬 Sem vídeo tutorial nesta página. Cadastre em Administração › Vídeos tutoriais (só você vê este aviso).</div>;
  }
  return (
    <>
      <button type="button" className="vh-card" onClick={() => setOpen(true)} aria-label={`Assistir vídeo: ${v.title}`}>
        <span className="vh-thumb"><img src={thumbUrl(v.videoId)} alt="" loading="lazy" /><span className="vh-play">▶</span></span>
        <span className="vh-text"><small>Vídeo explicativo desta página</small><strong>{v.title}</strong></span>
      </button>
      {open && (
        <div className="vh-modal" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
          <div className="vh-box" onClick={(e) => e.stopPropagation()}>
            <div className="vh-bar"><strong>{v.title}</strong><span><a href={v.url} target="_blank" rel="noopener noreferrer">Abrir no YouTube</a><button type="button" onClick={() => setOpen(false)} aria-label="Fechar">✕</button></span></div>
            <div className="vh-frame"><iframe src={`https://www.youtube-nocookie.com/embed/${v.videoId}?autoplay=1&rel=0`} title={v.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen /></div>
          </div>
        </div>
      )}
    </>
  );
}
