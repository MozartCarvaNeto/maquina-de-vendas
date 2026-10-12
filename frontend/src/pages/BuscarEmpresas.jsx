// frontend/src/pages/BuscarEmpresas.jsx
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import useCurrentUser from '../hooks/useCurrentUser';
import './BuscarEmpresas.css';

const SOURCES = [
  { value: 'google', label: '🗺️ Google Maps (mais completo)' },
  { value: 'openstreetmap', label: '🌍 OpenStreetMap (gratuito)' }
];

export default function BuscarEmpresas() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'owner' || user.role === 'admin';
  const [status, setStatus] = useState({ google: false });
  const [form, setForm] = useState({ query: '', location: '', source: 'google', limit: 40 });
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [enrich, setEnrich] = useState({ running: false, done: 0, total: 0 });
  const [listName, setListName] = useState('');
  const [extraTags, setExtraTags] = useState('');
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(null);
  const [onlyPhone, setOnlyPhone] = useState(false);

  useEffect(() => {
    api.get('/lead-search/status').then(({ data }) => {
      setStatus(data);
      if (!data.google) setForm((f) => ({ ...f, source: 'openstreetmap' }));
    }).catch(() => {});
  }, []);

  const visible = useMemo(() => results.filter((r) => !onlyPhone || r.phone), [results, onlyPhone]);
  const selectable = visible.filter((r) => r.phone || r.email);

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setDone(null);
    setSelected(new Set());
    try {
      const { data } = await api.post('/lead-search/search', form);
      setResults(data.results);
      setSearched(true);
      // Já deixa marcadas as empresas novas que têm telefone ou e-mail.
      setSelected(new Set(data.results.filter((r) => (r.phone || r.email) && !r.alreadyInBase).map((r) => r.id)));
      if (!listName) setListName(`${form.query} ${form.location}`.slice(0, 80));
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao buscar. Tente de novo.');
    } finally {
      setLoading(false);
    }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allOn = selectable.every((r) => selected.has(r.id));
    setSelected(allOn ? new Set() : new Set(selectable.map((r) => r.id)));
  }

  async function findEmails() {
    const pending = results.filter((r) => r.website && !r.email);
    if (!pending.length) return setError('Nenhuma empresa com site sem e-mail.');
    setError('');
    setEnrich({ running: true, done: 0, total: pending.length });
    for (let i = 0; i < pending.length; i += 10) {
      const batch = pending.slice(i, i + 10);
      try {
        const { data } = await api.post('/lead-search/enrich', { items: batch.map((b) => ({ id: b.id, website: b.website })) });
        setResults((prev) => prev.map((r) => (data.emails[r.id] ? { ...r, email: data.emails[r.id] } : r)));
      } catch (err) {
        setError(err.response?.data?.error || 'Falha ao procurar e-mails.');
        break;
      }
      setEnrich({ running: true, done: Math.min(i + 10, pending.length), total: pending.length });
    }
    setEnrich((s) => ({ ...s, running: false }));
  }

  async function handleImport() {
    if (!listName.trim()) return setError('Dê um nome para a lista.');
    const items = results.filter((r) => selected.has(r.id));
    if (!items.length) return setError('Marque pelo menos uma empresa.');
    setImporting(true);
    setError('');
    try {
      const { data } = await api.post('/lead-search/import', {
        listName: listName.trim(),
        segment: form.query,
        location: form.location,
        tags: extraTags.split(',').map((t) => t.trim()).filter(Boolean),
        items: items.map(({ name, phone, email, address }) => ({ name, phone, email, address }))
      });
      setDone(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao salvar a lista.');
    } finally {
      setImporting(false);
    }
  }

  const withSite = results.filter((r) => r.website && !r.email).length;

  return (
    <div className="busca-page">
      <header>
        <h1>🔍 Buscar Empresas</h1>
        <p>Digite o ramo e a cidade ou estado. O sistema encontra empresas, traz telefone e (quando existir) e-mail, e salva tudo numa lista para suas campanhas B2B.</p>
      </header>

      <form className="busca-form" onSubmit={handleSearch}>
        <div>
          <label>Ramo de atividade</label>
          <input value={form.query} onChange={(e) => setForm({ ...form, query: e.target.value })} placeholder="Ex: clínica odontológica" required minLength={3} />
        </div>
        <div>
          <label>Cidade ou estado</label>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Ex: Campinas SP  ou  Santa Catarina" required minLength={2} />
        </div>
        <div>
          <label>Fonte</label>
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label>Quantidade</label>
          <select value={form.limit} onChange={(e) => setForm({ ...form, limit: Number(e.target.value) })}>
            <option value={20}>até 20</option>
            <option value={40}>até 40</option>
            <option value={60}>até 60</option>
          </select>
        </div>
        <button className="btn-primary" type="submit" disabled={loading}>{loading ? 'Buscando…' : '🔍 Buscar'}</button>
      </form>

      {form.source === 'google' && !status.google && (
        <div className="busca-alert">
          Para usar o Google Maps é preciso cadastrar a sua chave gratuita do Google.{' '}
          {isAdmin ? <Link to="/configuracoes">Cadastrar em Configurações › Busca de empresas</Link> : 'Peça ao administrador da conta.'}
          {' '}Ou use a fonte gratuita (OpenStreetMap), que traz menos telefones.
        </div>
      )}
      {error && <div className="busca-alert busca-error">{error}</div>}

      {searched && (
        <>
          <div className="busca-summary">
            <strong>{results.length}</strong> empresas · <strong>{results.filter((r) => r.phone).length}</strong> com telefone · <strong>{results.filter((r) => r.email).length}</strong> com e-mail
            <label className="busca-check"><input type="checkbox" checked={onlyPhone} onChange={(e) => setOnlyPhone(e.target.checked)} /> só com telefone</label>
            {withSite > 0 && (
              <button type="button" className="btn-outline" onClick={findEmails} disabled={enrich.running}>
                {enrich.running ? `Procurando e-mails… ${enrich.done}/${enrich.total}` : `✉️ Procurar e-mails nos sites (${withSite})`}
              </button>
            )}
          </div>

          <div className="table-container">
            <table className="busca-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={selectable.length > 0 && selectable.every((r) => selected.has(r.id))} onChange={toggleAll} aria-label="Marcar todas" /></th>
                  <th>Empresa</th><th>Telefone</th><th>E-mail</th><th>Site</th><th>Endereço</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const usable = r.phone || r.email;
                  return (
                    <tr key={r.id} className={!usable ? 'busca-dim' : ''}>
                      <td><input type="checkbox" disabled={!usable} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                      <td>
                        <strong>{r.name}</strong>
                        {r.alreadyInBase && <span className="busca-tag">já na sua base</span>}
                        {r.mapsUrl && <a className="busca-link" href={r.mapsUrl} target="_blank" rel="noreferrer">ver no mapa</a>}
                      </td>
                      <td>{r.phone ? <>{r.phone}{r.whatsappLikely && <span className="busca-wa" title="Celular: provável WhatsApp">💬</span>}</> : '—'}</td>
                      <td>{r.email || '—'}</td>
                      <td>{r.website ? <a href={r.website} target="_blank" rel="noreferrer">{r.website.replace(/^https?:\/\/(www\.)?/, '').slice(0, 28)}</a> : '—'}</td>
                      <td className="busca-addr">{r.address || '—'}</td>
                    </tr>
                  );
                })}
                {visible.length === 0 && <tr><td colSpan={6} className="empty-state">Nenhuma empresa encontrada. Tente outro termo ou cidade.</td></tr>}
              </tbody>
            </table>
          </div>

          {results.length > 0 && (
            <div className="busca-save">
              <h3>💾 Salvar em uma lista de contatos</h3>
              {done ? (
                <div className="busca-ok">
                  ✅ Lista <strong>{done.list.name}</strong> criada: {done.created} contatos novos{done.reused ? `, ${done.reused} que você já tinha` : ''}{done.skipped ? `, ${done.skipped} sem telefone/e-mail ignorados` : ''}.
                  <div className="busca-ok-actions">
                    <Link className="btn-outline" to="/listas">Ver em Listas</Link>
                    <Link className="btn-outline" to="/disparos">Fazer um disparo</Link>
                    <Link className="btn-outline" to="/ligacoes">Ligar para a lista</Link>
                  </div>
                </div>
              ) : (
                <>
                  <div className="busca-form busca-save-form">
                    <div>
                      <label>Nome da lista</label>
                      <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Ex: Dentistas Campinas" maxLength={80} />
                    </div>
                    <div>
                      <label>Etiquetas extras (opcional)</label>
                      <input value={extraTags} onChange={(e) => setExtraTags(e.target.value)} placeholder="Ex: prioridade, outubro" />
                    </div>
                    <button className="btn-primary" onClick={handleImport} disabled={importing || selected.size === 0}>
                      {importing ? 'Salvando…' : `Salvar ${selected.size} empresas`}
                    </button>
                  </div>
                  <p className="hint-text">
                    Os contatos entram com origem "Busca de empresas B2B" e as etiquetas b2b e o ramo. Dados de empresas são informações públicas de negócios; ao abordar, identifique-se, ofereça a opção de sair da lista e respeite a LGPD.
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
