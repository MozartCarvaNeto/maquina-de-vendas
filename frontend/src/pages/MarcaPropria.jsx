// frontend/src/pages/MarcaPropria.jsx — white-label: nome, subtítulo, cor e logo do cliente no painel
import { useState, useEffect } from 'react';
import api from '../services/api';
import { USER_UPDATED_EVENT } from '../hooks/useCurrentUser';
import '../components/account/Account.css';

export default function MarcaPropria() {
  const [b, setB] = useState({ name: '', subtitle: '', color: '', logo: '' });
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api.get('/account/brand').then((r) => setB(r.data.brand)).catch(() => {});
  }, []);

  function pickLogo(e) {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 200 * 1024) { setMsg({ error: true, text: 'Logo muito grande: use até 200 KB (PNG, JPG ou WEBP).' }); return; }
    const reader = new FileReader();
    reader.onload = () => setB((p) => ({ ...p, logo: String(reader.result) }));
    reader.readAsDataURL(f);
  }

  async function save(e) {
    e.preventDefault();
    try {
      await api.put('/account/brand', b);
      const { data } = await api.get('/auth/me');
      const stored = JSON.parse(localStorage.getItem('mdv_user') || '{}');
      localStorage.setItem('mdv_user', JSON.stringify({ ...stored, ...data.user }));
      window.dispatchEvent(new Event(USER_UPDATED_EVENT));
      setMsg({ text: 'Marca salva! Ela já aparece no menu e no topo para toda a sua equipe.' });
    } catch (err) {
      setMsg({ error: true, text: err.response?.data?.error || 'Erro ao salvar.' });
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1>🎨 Marca própria</h1>
      <p className="acc-muted">Coloque o nome, a cor e o logo da sua empresa no painel. Sua equipe passa a ver a sua marca no menu e no topo. Deixe em branco para voltar ao padrão.</p>
      {msg && <div className={`acc-msg ${msg.error ? 'is-error' : ''}`}>{msg.text}</div>}
      <form className="acc-card" onSubmit={save}>
        <div className="acc-grid">
          <div><label htmlFor="mb-name">Nome da marca</label><input id="mb-name" maxLength={40} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Minha Empresa Vendas" /></div>
          <div><label htmlFor="mb-sub">Subtítulo</label><input id="mb-sub" maxLength={40} value={b.subtitle} onChange={(e) => setB({ ...b, subtitle: e.target.value })} placeholder="Central de vendas" /></div>
          <div><label htmlFor="mb-color">Cor principal</label><input id="mb-color" type="color" value={b.color || '#0096c7'} onChange={(e) => setB({ ...b, color: e.target.value })} /></div>
          <div><label htmlFor="mb-logo">Logo (PNG/JPG/WEBP, até 200 KB)</label><input id="mb-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={pickLogo} /></div>
        </div>
        {b.logo && <div className="acc-row"><img src={b.logo} alt="Prévia do logo" style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 12 }} /><button type="button" className="btn-outline" onClick={() => setB({ ...b, logo: '' })}>Remover logo</button></div>}
        <div className="acc-row">
          <button className="btn-primary" type="submit">Salvar marca</button>
          <button className="btn-outline" type="button" onClick={() => setB({ name: '', subtitle: '', color: '', logo: '' })}>Voltar ao padrão</button>
        </div>
      </form>
    </div>
  );
}
