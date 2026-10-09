// frontend/src/pages/Dashboard.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import FollowUpPanel from '../components/crm/FollowUpPanel';
import useCurrentUser from '../hooks/useCurrentUser';
import { userHasFeature } from '../utils/features';
import './Dashboard.css';

export default function Dashboard() {
  const user = useCurrentUser();
  const hasCrm = userHasFeature(user, 'crm');
  const hasContacts = userHasFeature(user, 'contatos');
  const [stats, setStats] = useState({
    totalLeads: 0,
    qualificados: 0,
    emNegociacao: 0,
    fechados: 0
  });

  const loadStats = useCallback(async () => {
    if (!hasContacts) return;
    try {
      const [totalRes, qualRes, negRes, fechRes] = await Promise.all([
        api.get('/leads?pageSize=1'),
        api.get('/leads?status=qualificado&pageSize=1'),
        api.get('/leads?status=em_negociacao&pageSize=1'),
        api.get('/leads?status=fechado&pageSize=1')
      ]);
      setStats({
        totalLeads: totalRes.data.total,
        qualificados: qualRes.data.total,
        emNegociacao: negRes.data.total,
        fechados: fechRes.data.total
      });
    } catch (error) {
      console.error('Erro ao carregar métricas:', error);
    }
  }, [hasContacts]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="dashboard-page">
      <header>
        <h1>Visão Geral</h1>
        <p>Acompanhe suas métricas de qualificação e vendas.</p>
      </header>

      {hasCrm && <FollowUpPanel />}

      <div className="dashboard-metrics">
        <div className="metric-card">
          <h3>Total de Leads</h3>
          <span className="value">{stats.totalLeads}</span>
        </div>
        <div className="metric-card">
          <h3>Qualificados</h3>
          <span className="value primary">{stats.qualificados}</span>
        </div>
        <div className="metric-card">
          <h3>Em Negociação</h3>
          <span className="value">{stats.emNegociacao}</span>
        </div>
        <div className="metric-card">
          <h3>Fechados</h3>
          <span className="value success">{stats.fechados}</span>
        </div>
      </div>
    </div>
  );
}