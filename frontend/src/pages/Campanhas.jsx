// frontend/src/pages/Campanhas.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { AI_PROVIDERS, aiProviderLabel } from '../utils/aiProviders';
import './Campanhas.css';

const SOURCES = [
  { value: 'facebook_ads', label: '📘 Facebook / Instagram Ads', help: 'O WhatsApp informa o anúncio automaticamente (anúncio "Clique para o WhatsApp").' },
  { value: 'google_ads', label: '🔎 Google Ads', help: 'Use o link rastreável abaixo como destino do anúncio.' },
  { value: 'instagram', label: '📸 Instagram (orgânico)', help: 'Link da bio / stories com o link rastreável.' },
  { value: 'indicacao', label: '🤝 Indicação', help: 'Clientes indicados por outros clientes.' },
  { value: 'site', label: '🛒 Site / loja online', help: 'Botão de WhatsApp do site com o link rastreável.' },
  { value: 'cliente', label: '⭐ Cliente que já compra', help: 'Quem já é cliente (suporte e recompra).' },
  { value: 'organico', label: '💬 Contato espontâneo', help: 'Quem chega sem anúncio nem código.' },
  { value: 'outro', label: '📦 Outra origem', help: '' }
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));
SOURCE_LABEL.importado = '📥 Lista importada';
SOURCE_LABEL.prospeccao_b2b = '🔍 Busca de empresas (B2B)';
SOURCE_LABEL.sem_origem = '❔ Sem origem';

const OBJECTIVES = [
  { value: 'qualificar', label: 'Qualificar (descobrir se tem perfil)' },
  { value: 'vender', label: 'Vender (apresentar e fechar)' },
  { value: 'agendar', label: 'Agendar (visita, ligação ou reunião)' },
  { value: 'suporte', label: 'Suporte e recompra (clientes atuais)' }
];
const TONES = [
  { value: 'cordial', label: 'Cordial e acolhedor' },
  { value: 'descontraido', label: 'Descontraído e próximo' },
  { value: 'formal', label: 'Formal e profissional' },
  { value: 'consultivo', label: 'Consultivo (sem pressão)' }
];
const STEP_TYPES = [
  { value: 'number_min', label: 'Número mínimo (ex: renda mínima)' },
  { value: 'number_max', label: 'Número máximo (ex: idade máxima)' },
  { value: 'boolean_true', label: 'Sim/Não (precisa ser "sim")' },
  { value: 'one_of', label: 'Uma opção da lista' }
];
const TABS = [
  { id: 'origem', label: '1. Origem' },
  { id: 'robo', label: '2. Robô' },
  { id: 'conhecimento', label: '3. Conhecimento' },
  { id: 'qualificacao', label: '4. Qualificação' },
  { id: 'followup', label: '5. Follow-up' },
  { id: 'testar', label: '6. Testar' }
];

const emptyStep = () => ({ id: '', question: '', type: 'boolean_true', minValue: '', maxValue: '', acceptedValues: '' });

const emptyForm = () => ({
  name: '', enterpriseName: '', active: true, isDefault: false,
  sourceType: 'facebook_ads', triggerKeywords: '', adSourceIds: '', whatsappConnectionId: '',
  botEnabled: true, firstMessage: '', botPrompt: '', aiProviderOverride: '',
  cfg: { persona: '', objective: 'qualificar', tone: 'cordial', offer: '', audience: '', rules: '', forbidden: '', faq: '', handoff: '', closing: '', emojis: true },
  catalogUrl: '', catalogText: '',
  followUpEnabled: true, followUpDays: 7, followUpMessage: '', nutritionDays: 30, nutritionMessage: '',
  qualificationLogic: 'ALL', steps: [emptyStep()]
});

function slugCode(name) {
  const base = String(name || 'camp').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase().slice(0, 14) || 'CAMP';
  const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${base}-${rnd}`;
}

export default function Campanhas() {
  const [view, setView] = useState('campanhas');
  const [campaigns, setCampaigns] = useState([]);
  const [aiProviders, setAiProviders] = useState([]);
  const [connections, setConnections] = useState([]);
  const [report, setReport] = useState(null);
  const [days, setDays] = useState('30');
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState('origem');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [phoneForLink, setPhoneForLink] = useState('');
  const [prompt, setPrompt] = useState('');
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSource, setChatSource] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [collected, setCollected] = useState({});
  const [chatError, setChatError] = useState('');

  const loadCampaigns = useCallback(async () => {
    const { data } = await api.get('/campaigns');
    setCampaigns(data.campaigns);
  }, []);

  const loadReport = useCallback(async () => {
    const { data } = await api.get('/campaigns/report', { params: { days } });
    setReport(data);
  }, [days]);

  useEffect(() => {
    loadCampaigns();
    api.get('/whatsapp/connections').then(({ data }) => setConnections(data.connections || [])).catch(() => setConnections([]));
    api.get('/settings/ai').then(({ data }) => setAiProviders(data.providers)).catch(() => setAiProviders([]));
  }, [loadCampaigns]);

  useEffect(() => {
    if (view === 'resultados') loadReport().catch(() => setReport({ campaigns: [], sources: [] }));
  }, [view, loadReport]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const setCfg = (patch) => setForm((prev) => ({ ...prev, cfg: { ...prev.cfg, ...patch } }));

  function openModal(campaign) {
    setTab('origem');
    setPrompt('');
    setChat([]);
    setCollected({});
    setChatError('');
    setNotice('');
    if (!campaign) {
      setEditingId(null);
      setForm(emptyForm());
      setChatSource('');
    } else {
      setEditingId(campaign.id);
      setChatSource('');
      setForm({
        ...emptyForm(),
        name: campaign.name,
        enterpriseName: campaign.enterpriseName || '',
        active: campaign.active,
        isDefault: campaign.isDefault,
        sourceType: campaign.sourceType || 'outro',
        triggerKeywords: (campaign.triggerKeywords || []).join(', '),
        adSourceIds: (campaign.adSourceIds || []).join(', '),
        whatsappConnectionId: campaign.whatsappConnectionId || '',
        botEnabled: campaign.botEnabled !== false,
        firstMessage: campaign.firstMessage || '',
        botPrompt: campaign.botPrompt || '',
        aiProviderOverride: campaign.aiProviderOverride || '',
        cfg: { ...emptyForm().cfg, ...(campaign.botConfig || {}) },
        catalogUrl: campaign.catalogUrl || '',
        catalogText: campaign.catalogText || '',
        followUpEnabled: campaign.followUpEnabled,
        followUpDays: campaign.followUpDays,
        followUpMessage: campaign.followUpMessage || '',
        nutritionDays: campaign.nutritionDays,
        nutritionMessage: campaign.nutritionMessage || '',
        qualificationLogic: campaign.qualificationRules?.logic || 'ALL',
        steps: campaign.qualificationRules?.steps?.length
          ? campaign.qualificationRules.steps.map((s) => ({
              id: s.id, question: s.question, type: s.type,
              minValue: s.minValue ?? '', maxValue: s.maxValue ?? '', acceptedValues: (s.acceptedValues || []).join(', ')
            }))
          : [emptyStep()]
      });
    }
    setShowModal(true);
  }

  function updateStep(index, patch) {
    setForm((prev) => ({ ...prev, steps: prev.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  }

  function buildPayload() {
    return {
      name: form.name,
      enterpriseName: form.enterpriseName,
      active: form.active,
      isDefault: form.isDefault,
      sourceType: form.sourceType,
      triggerKeywords: form.triggerKeywords,
      adSourceIds: form.adSourceIds,
      whatsappConnectionId: form.whatsappConnectionId || null,
      botEnabled: form.botEnabled,
      firstMessage: form.firstMessage,
      botPrompt: form.botPrompt,
      aiProviderOverride: form.aiProviderOverride || null,
      botConfig: form.cfg,
      catalogUrl: form.catalogUrl,
      catalogText: form.catalogText,
      followUpEnabled: form.followUpEnabled,
      followUpDays: Number(form.followUpDays),
      followUpMessage: form.followUpMessage,
      nutritionDays: Number(form.nutritionDays),
      nutritionMessage: form.nutritionMessage,
      qualificationRules: {
        logic: form.qualificationLogic,
        steps: form.steps
          .filter((s) => s.question.trim())
          .map((s) => ({
            id: s.id.trim() || s.question.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').slice(0, 30),
            question: s.question, type: s.type, minValue: s.minValue, maxValue: s.maxValue, acceptedValues: s.acceptedValues
          }))
      }
    };
  }

  async function handleSave(e) {
    e?.preventDefault();
    if (!form.name.trim()) {
      setTab('origem');
      setNotice('Dê um nome para a campanha.');
      return;
    }
    setSaving(true);
    try {
      const { data } = editingId ? await api.put(`/campaigns/${editingId}`, buildPayload()) : await api.post('/campaigns', buildPayload());
      if (data.catalogWarning) {
        window.alert(`Campanha salva, mas não consegui ler o site: ${data.catalogWarning}\nVocê pode colar o catálogo em texto na aba Conhecimento.`);
      }
      setShowModal(false);
      loadCampaigns();
    } catch (error) {
      setNotice(error.response?.data?.error || 'Erro ao salvar campanha');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Excluir esta campanha? Os leads vinculados a ela ficarão sem campanha.')) return;
    await api.delete(`/campaigns/${id}`);
    loadCampaigns();
  }

  async function refreshCatalog() {
    setNotice('Lendo o site…');
    try {
      const { data } = await api.post(`/campaigns/${editingId}/catalog/refresh`);
      setNotice(`✅ Site lido: ${data.pages} páginas, ${data.chars.toLocaleString('pt-BR')} caracteres.`);
      loadCampaigns();
    } catch (error) {
      setNotice(`❌ ${error.response?.data?.error || 'Não consegui ler o site'}`);
    }
  }

  function onCatalogFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return setNotice('Arquivo muito grande (máximo 1 MB). Use um .txt ou .csv menor.');
    const reader = new FileReader();
    reader.onload = () => set({ catalogText: `${form.catalogText ? `${form.catalogText}\n\n` : ''}${String(reader.result || '')}`.slice(0, 60000) });
    reader.readAsText(file);
  }

  async function loadPrompt() {
    try {
      const { data } = await api.post('/campaigns/preview-prompt', { campaign: { ...buildPayload(), id: editingId }, source: chatSource || form.sourceType });
      setPrompt(data.prompt);
    } catch (error) {
      setPrompt(error.response?.data?.error || 'Não foi possível montar a prévia.');
    }
  }

  async function sendTest(e) {
    e.preventDefault();
    const message = chatInput.trim();
    if (!message || chatBusy) return;
    const history = chat.map((c) => ({ role: c.role, text: c.text }));
    setChat((c) => [...c, { role: 'user', text: message }]);
    setChatInput('');
    setChatBusy(true);
    setChatError('');
    try {
      const { data } = await api.post('/campaigns/test', {
        campaign: { ...buildPayload(), id: editingId },
        source: chatSource || form.sourceType,
        history,
        message
      });
      setChat((c) => [...c, { role: 'model', text: data.reply || '(sem resposta)' }]);
      setCollected((prev) => ({ ...prev, ...data.collected }));
      if (data.handoff) setChat((c) => [...c, { role: 'system', text: '🙋 O robô passaria esta conversa para uma pessoa.' }]);
    } catch (error) {
      setChatError(error.response?.data?.error || 'Erro ao testar');
    } finally {
      setChatBusy(false);
    }
  }

  const firstKeyword = form.triggerKeywords.split(',')[0]?.trim();
  const trackedLink = (() => {
    const digits = phoneForLink.replace(/\D/g, '');
    if (!digits || !firstKeyword) return '';
    const text = `Olá! Quero saber mais. Código: ${firstKeyword}`;
    return `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}?text=${encodeURIComponent(text)}`;
  })();

  const sourceHelp = SOURCES.find((s) => s.value === form.sourceType)?.help;
  const providerOptions = aiProviders.length ? aiProviders : [];

  return (
    <div className="campanhas-page">
      <header>
        <h1>Campanhas</h1>
        <p>Cada campanha identifica de onde o lead veio, ensina o robô de WhatsApp a atender e qualifica automaticamente.</p>
      </header>

      <div className="camp-tabs">
        <button className={view === 'campanhas' ? 'active' : ''} onClick={() => setView('campanhas')}>📣 Minhas campanhas</button>
        <button className={view === 'resultados' ? 'active' : ''} onClick={() => setView('resultados')}>📊 Resultados por origem</button>
      </div>

      {view === 'campanhas' && (
        <>
          <div className="campanhas-toolbar">
            <button className="btn-primary" onClick={() => openModal(null)}>➕ Nova Campanha</button>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr><th>Campanha</th><th>Origem</th><th>Códigos</th><th>Leads</th><th>Robô</th><th>Status</th><th>Ações</th></tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      {c.isDefault && <span className="status-tag default-tag">Padrão</span>}
                      <div className="hint-text">{c.enterpriseName || ''}</div>
                    </td>
                    <td>{SOURCE_LABEL[c.sourceType] || c.sourceType}</td>
                    <td className="kw-cell">{(c.triggerKeywords || []).join(', ') || (c.adSourceIds?.length ? 'Anúncio' : '—')}</td>
                    <td>{c._count?.leads ?? 0}</td>
                    <td>{c.botEnabled && (c.botConfig || c.botPrompt) ? '🤖 Ligado' : '—'}{c.catalogWebChars || c.catalogText ? ' 📚' : ''}</td>
                    <td><span className={`status-tag ${c.active ? 'active' : 'inactive'}`}>{c.active ? 'Ativa' : 'Inativa'}</span></td>
                    <td className="camp-actions">
                      <button className="btn-outline" onClick={() => openModal(c)}>Editar</button>
                      <button className="btn-danger-small" onClick={() => handleDelete(c.id)}>Excluir</button>
                    </td>
                  </tr>
                ))}
                {campaigns.length === 0 && (
                  <tr><td colSpan={7} className="empty-state">Nenhuma campanha criada ainda</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'resultados' && (
        <div className="camp-report">
          <div className="camp-report-filter">
            <label>Período</label>
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">Últimos 7 dias</option>
              <option value="30">Últimos 30 dias</option>
              <option value="90">Últimos 90 dias</option>
              <option value="0">Todo o período</option>
            </select>
          </div>

          {!report && <p className="hint-text">Carregando…</p>}
          {report && (
            <>
              <h3>De onde vêm seus leads</h3>
              <div className="source-cards">
                {report.sources.map((s) => (
                  <div className="source-card" key={s.source}>
                    <span>{SOURCE_LABEL[s.source] || s.source}</span>
                    <strong>{s.count}</strong>
                  </div>
                ))}
                {report.sources.length === 0 && <p className="hint-text">Ainda não há leads neste período.</p>}
              </div>

              <h3>Desempenho de cada campanha</h3>
              <div className="table-container">
                <table>
                  <thead>
                    <tr><th>Campanha</th><th>Origem</th><th>Leads</th><th>Em andamento</th><th>Qualificados</th><th>Desqualificados</th><th>Taxa</th></tr>
                  </thead>
                  <tbody>
                    {report.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}{!c.active && c.id !== 'none' ? ' (inativa)' : ''}</td>
                        <td>{SOURCE_LABEL[c.sourceType] || '—'}</td>
                        <td>{c.total}</td>
                        <td>{c.novos}</td>
                        <td>{c.qualificados}</td>
                        <td>{c.desqualificados}</td>
                        <td>{c.taxaQualificacao === null ? '—' : `${c.taxaQualificacao}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint-text">Taxa = qualificados ÷ (qualificados + desqualificados). Também dá para filtrar por campanha em Contatos.</p>
            </>
          )}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-large camp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="camp-modal-head">
              <h2>{editingId ? 'Editar Campanha' : 'Nova Campanha'}</h2>
              <button type="button" className="camp-close" onClick={() => setShowModal(false)} aria-label="Fechar">✕</button>
            </div>

            <div className="camp-steps" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); if (t.id === 'testar') loadPrompt(); }}>
                  {t.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleSave}>
              {notice && <div className="camp-notice">{notice}</div>}

              {tab === 'origem' && (
                <section>
                  <div className="form-row">
                    <div>
                      <label>Nome da campanha</label>
                      <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex: Joias no atacado — Facebook" required />
                    </div>
                    <div>
                      <label>Empresa / empreendimento</label>
                      <input value={form.enterpriseName} onChange={(e) => set({ enterpriseName: e.target.value })} placeholder="Como o robô vai se referir à empresa" />
                    </div>
                  </div>

                  <label>De onde vêm os leads desta campanha?</label>
                  <select value={form.sourceType} onChange={(e) => set({ sourceType: e.target.value })}>
                    {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  {sourceHelp && <p className="hint-text">{sourceHelp}</p>}

                  <label>Códigos que identificam esta campanha</label>
                  <div className="inline-field">
                    <input value={form.triggerKeywords} onChange={(e) => set({ triggerKeywords: e.target.value })} placeholder="Ex: JOIAS-FB1, quero joias no atacado" />
                    <button type="button" className="btn-outline" onClick={() => set({ triggerKeywords: [form.triggerKeywords, slugCode(form.name)].filter(Boolean).join(', ') })}>Gerar código</button>
                  </div>
                  <p className="hint-text">
                    Quando o lead escrever um destes códigos (ou frases) na conversa, ele entra nesta campanha. Separe por vírgula. O link rastreável abaixo já coloca o código sozinho na mensagem.
                  </p>

                  {form.sourceType === 'facebook_ads' && (
                    <>
                      <label>IDs de anúncio (opcional)</label>
                      <input value={form.adSourceIds} onChange={(e) => set({ adSourceIds: e.target.value })} placeholder="Só se você tem vários anúncios e quer separar por ID" />
                      <p className="hint-text">Em anúncios "Clique para o WhatsApp" o sistema reconhece sozinho que o lead veio do Facebook/Instagram. Se houver só uma campanha de Facebook, ela é usada automaticamente.</p>
                    </>
                  )}

                  <label>WhatsApp desta campanha</label>
                  <select value={form.whatsappConnectionId} onChange={(e) => set({ whatsappConnectionId: e.target.value })}>
                    <option value="">Qualquer número (o robô responde pelo número em que o lead escreveu)</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.instanceName}{c.phone ? ` — ${c.phone}` : ''}{c.status !== 'conectado' ? ' (desconectado)' : ''}</option>
                    ))}
                  </select>
                  <p className="hint-text">Se escolher um número, quem escrever para ele entra nesta campanha (mesmo sem código), e os follow-ups saem por ele. Use o mesmo número no link rastreável.</p>

                  <div className="track-box">
                    <strong>🔗 Link rastreável (use como destino do anúncio, bio, site)</strong>
                    <input value={phoneForLink} onChange={(e) => setPhoneForLink(e.target.value)} placeholder="WhatsApp que recebe as mensagens (com DDD)" inputMode="tel" />
                    {trackedLink ? (
                      <>
                        <code>{trackedLink}</code>
                        <button type="button" className="btn-outline" onClick={() => navigator.clipboard?.writeText(trackedLink).then(() => setNotice('Link copiado!'))}>Copiar link</button>
                      </>
                    ) : (
                      <p className="hint-text">Preencha o número e pelo menos um código acima.</p>
                    )}
                  </div>

                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} />
                    Campanha padrão: atende quem chega sem código (clientes regulares, indicações, quem já compra no site)
                  </label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
                    Campanha ativa
                  </label>
                </section>
              )}

              {tab === 'robo' && (
                <section>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.botEnabled} onChange={(e) => set({ botEnabled: e.target.checked })} />
                    Robô de IA responde automaticamente no WhatsApp
                  </label>

                  <div className="form-row">
                    <div>
                      <label>Nome do atendente virtual</label>
                      <input value={form.cfg.persona} onChange={(e) => setCfg({ persona: e.target.value })} placeholder="Ex: Luna" />
                    </div>
                    <div>
                      <label>Objetivo da conversa</label>
                      <select value={form.cfg.objective} onChange={(e) => setCfg({ objective: e.target.value })}>
                        {OBJECTIVES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="form-row">
                    <div>
                      <label>Tom de voz</label>
                      <select value={form.cfg.tone} onChange={(e) => setCfg({ tone: e.target.value })}>
                        {TONES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label>IA desta campanha</label>
                      <select value={form.aiProviderOverride} onChange={(e) => set({ aiProviderOverride: e.target.value })}>
                        <option value="">Usar a IA padrão da conta</option>
                        {providerOptions.map((p) => <option key={p} value={p}>{aiProviderLabel(p)}</option>)}
                      </select>
                    </div>
                  </div>
                  {aiProviders.length === 0 && (
                    <p className="hint-text">Nenhuma IA configurada ainda. Vá em Configurações › Inteligência Artificial ({AI_PROVIDERS.length} opções disponíveis).</p>
                  )}
                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.cfg.emojis !== false} onChange={(e) => setCfg({ emojis: e.target.checked })} />
                    Pode usar emojis
                  </label>

                  <label>O que você vende / oferece nesta campanha</label>
                  <textarea rows={4} maxLength={3000} value={form.cfg.offer} onChange={(e) => setCfg({ offer: e.target.value })} placeholder="Ex: Joias de titânio e ouro para estúdios de piercing, venda no atacado a partir de 20 peças, frete grátis acima de R$ 800, prazo de 5 dias úteis." />

                  <label>Público ideal</label>
                  <textarea rows={2} maxLength={600} value={form.cfg.audience} onChange={(e) => setCfg({ audience: e.target.value })} placeholder="Ex: Donos de estúdios de piercing e lojistas que revendem bijuteria fina." />

                  <label>Primeira mensagem (abertura)</label>
                  <textarea rows={2} maxLength={600} value={form.firstMessage} onChange={(e) => set({ firstMessage: e.target.value })} placeholder="Ex: Oi! Aqui é a Luna 😊 Vi que você se interessou pelas nossas joias. Posso te ajudar?" />

                  <label>Sempre faça</label>
                  <textarea rows={3} maxLength={3000} value={form.cfg.rules} onChange={(e) => setCfg({ rules: e.target.value })} placeholder={'Ex:\n- Pergunte o nome da pessoa\n- Ofereça o catálogo completo se ela pedir\n- Confirme o CEP antes de falar de frete'} />

                  <label>Nunca faça</label>
                  <textarea rows={3} maxLength={3000} value={form.cfg.forbidden} onChange={(e) => setCfg({ forbidden: e.target.value })} placeholder={'Ex:\n- Não dar desconto sem autorização\n- Não prometer prazo menor que 5 dias\n- Não falar de concorrentes'} />

                  <label>Perguntas frequentes (pergunta e resposta)</label>
                  <textarea rows={4} maxLength={3000} value={form.cfg.faq} onChange={(e) => setCfg({ faq: e.target.value })} placeholder={'Ex:\nP: Vocês emitem nota fiscal?\nR: Sim, em todos os pedidos.\nP: Qual o pedido mínimo?\nR: 20 peças.'} />

                  <label>Quando passar para uma pessoa</label>
                  <textarea rows={2} maxLength={1500} value={form.cfg.handoff} onChange={(e) => setCfg({ handoff: e.target.value })} placeholder="Ex: Quando pedir negociação de preço, reclamar de pedido ou quiser falar com o dono." />

                  <label>Próximo passo desejado</label>
                  <input maxLength={600} value={form.cfg.closing} onChange={(e) => setCfg({ closing: e.target.value })} placeholder="Ex: Enviar o link do catálogo e perguntar se quer fazer o primeiro pedido." />

                  <label>Instruções extras (texto livre, opcional)</label>
                  <textarea rows={3} maxLength={3000} value={form.botPrompt} onChange={(e) => set({ botPrompt: e.target.value })} placeholder="Qualquer orientação que não coube nos campos acima." />
                </section>
              )}

              {tab === 'conhecimento' && (
                <section>
                  <p className="hint-text">O robô só fala de produtos, preços e prazos que estiverem aqui. Quanto melhor o catálogo, melhor a resposta.</p>

                  <label>Site com os produtos</label>
                  <div className="inline-field">
                    <input value={form.catalogUrl} onChange={(e) => set({ catalogUrl: e.target.value })} placeholder="https://www.seusite.com.br (ou a página de uma categoria)" />
                    {editingId && form.catalogUrl && <button type="button" className="btn-outline" onClick={refreshCatalog}>Reler site</button>}
                  </div>
                  <p className="hint-text">O sistema lê a página inicial e as páginas de produtos. Ao salvar, o site é lido de novo. Para um catálogo específico, cole o endereço da categoria/coleção.</p>

                  <label>Catálogo em texto (produtos, preços, prazos, condições)</label>
                  <textarea rows={9} maxLength={60000} value={form.catalogText} onChange={(e) => set({ catalogText: e.target.value })} placeholder={'Ex:\nLabret titânio 1,2mm — R$ 18 — 6 cores\nArgola ouro 18k — R$ 240\nPedido mínimo 20 peças. Pagamento: Pix 5% de desconto.'} />
                  <div className="inline-field">
                    <label className="btn-outline file-btn">
                      📎 Importar arquivo (.txt, .csv, .md)
                      <input type="file" accept=".txt,.csv,.md,.json,text/plain,text/csv" onChange={onCatalogFile} hidden />
                    </label>
                    <span className="hint-text">{form.catalogText.length.toLocaleString('pt-BR')} / 60.000 caracteres</span>
                  </div>
                  <p className="hint-text">Dica: planilha do Excel? Salve como CSV e importe aqui.</p>
                </section>
              )}

              {tab === 'qualificacao' && (
                <section>
                  <p className="hint-text">O robô faz estas perguntas na conversa (uma por vez) e guarda as respostas. Quando todas forem respondidas, o lead é qualificado ou não e, se qualificado, vai para o CRM.</p>
                  <label>Lógica</label>
                  <select value={form.qualificationLogic} onChange={(e) => set({ qualificationLogic: e.target.value })}>
                    <option value="ALL">Precisa passar em TODAS as etapas</option>
                    <option value="ANY">Precisa passar em QUALQUER etapa</option>
                  </select>

                  {form.steps.map((step, index) => (
                    <div className="step-card" key={index}>
                      <input placeholder="Pergunta ao lead (ex: Qual o seu faturamento mensal?)" value={step.question} onChange={(e) => updateStep(index, { question: e.target.value })} />
                      <div className="step-grid">
                        <select value={step.type} onChange={(e) => updateStep(index, { type: e.target.value })}>
                          {STEP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                        {step.type === 'number_min' && <input type="number" placeholder="Valor mínimo" value={step.minValue} onChange={(e) => updateStep(index, { minValue: e.target.value })} />}
                        {step.type === 'number_max' && <input type="number" placeholder="Valor máximo" value={step.maxValue} onChange={(e) => updateStep(index, { maxValue: e.target.value })} />}
                        {step.type === 'one_of' && <input placeholder="Opções aceitas, separadas por vírgula" value={step.acceptedValues} onChange={(e) => updateStep(index, { acceptedValues: e.target.value })} />}
                        <input placeholder="Código interno (opcional)" value={step.id} onChange={(e) => updateStep(index, { id: e.target.value })} />
                        <button type="button" className="btn-danger-small" onClick={() => set({ steps: form.steps.filter((_, i) => i !== index) })}>Remover</button>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn-outline" onClick={() => set({ steps: [...form.steps, emptyStep()] })}>➕ Adicionar pergunta</button>
                </section>
              )}

              {tab === 'followup' && (
                <section>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={form.followUpEnabled} onChange={(e) => set({ followUpEnabled: e.target.checked })} />
                    Ativar follow-up/nutrição automática
                  </label>
                  <div className="form-row">
                    <div>
                      <label>Follow-up após (dias sem resposta)</label>
                      <input type="number" min="1" value={form.followUpDays} onChange={(e) => set({ followUpDays: e.target.value })} />
                    </div>
                    <div>
                      <label>Nutrição após (dias sem resposta)</label>
                      <input type="number" min="1" value={form.nutritionDays} onChange={(e) => set({ nutritionDays: e.target.value })} />
                    </div>
                  </div>
                  <label>Mensagem de follow-up</label>
                  <textarea rows={2} value={form.followUpMessage} onChange={(e) => set({ followUpMessage: e.target.value })} />
                  <label>Mensagem de nutrição</label>
                  <textarea rows={2} value={form.nutritionMessage} onChange={(e) => set({ nutritionMessage: e.target.value })} />
                </section>
              )}

              {tab === 'testar' && (
                <section>
                  <p className="hint-text">Converse com o robô como se fosse um cliente. Isso usa a sua IA (gasta poucos centavos) e não envia nada pelo WhatsApp.</p>
                  <label>Simular lead vindo de</label>
                  <select value={chatSource || form.sourceType} onChange={(e) => { setChatSource(e.target.value); setChat([]); setCollected({}); }}>
                    {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>

                  <div className="chat-box">
                    {chat.length === 0 && <p className="hint-text">Escreva abaixo a primeira mensagem do cliente.</p>}
                    {chat.map((m, i) => (
                      <div key={i} className={`bubble ${m.role}`}>{m.text}</div>
                    ))}
                    {chatBusy && <div className="bubble model">…</div>}
                  </div>
                  {chatError && <div className="camp-notice">{chatError}</div>}
                  {Object.keys(collected).length > 0 && (
                    <div className="collected">📝 Respostas que o robô registraria: {Object.entries(collected).map(([k, v]) => `${k} = ${String(v)}`).join(' · ')}</div>
                  )}
                  <div className="inline-field">
                    <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendTest(e); }} placeholder="Mensagem do cliente…" />
                    <button type="button" className="btn-primary" onClick={sendTest} disabled={chatBusy}>Enviar</button>
                    <button type="button" className="btn-outline" onClick={() => { setChat([]); setCollected({}); }}>Limpar</button>
                  </div>

                  <details className="prompt-preview" onToggle={(e) => e.target.open && loadPrompt()}>
                    <summary>👁️ Ver o prompt completo que o robô recebe</summary>
                    <pre>{prompt || 'Carregando…'}</pre>
                  </details>
                </section>
              )}

              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar campanha'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
