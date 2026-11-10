// frontend/src/pages/Legal.jsx — Termos de Uso e Política de Privacidade (públicas, sem login)
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import '../components/account/Account.css';

export default function Legal({ kind }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/legal').then((r) => setData(r.data)).catch(() => setError('Não foi possível carregar o texto agora.'));
  }, []);
  const isTerms = kind === 'terms';
  const sections = data ? (isTerms ? data.terms : data.privacy) : [];
  return (
    <div className="legal-page">
      <Link to="/login">← Voltar</Link>
      <h1>{isTerms ? 'Termos de Uso' : 'Política de Privacidade'}</h1>
      {data && <p className="legal-note">Versão {data.version} · {data.company.name}</p>}
      {error && <div className="acc-msg is-error">{error}</div>}
      {!data && !error && <p>Carregando…</p>}
      {sections.map((s, i) => (
        <section key={i}>
          <h2>{s.h}</h2>
          {s.p.map((t, j) => <p key={j}>{t}</p>)}
        </section>
      ))}
      <p className="legal-note">{isTerms ? <Link to="/privacidade">Ver Política de Privacidade</Link> : <Link to="/termos">Ver Termos de Uso</Link>}</p>
    </div>
  );
}
