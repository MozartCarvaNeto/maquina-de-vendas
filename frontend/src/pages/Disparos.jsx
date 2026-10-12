// frontend/src/pages/Disparos.jsx
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import api from '../services/api';
import { ATTACHMENT_REGEX, BLOCKED_EXT_REGEX, ATTACHMENT_ACCEPT } from '../utils/attachments';
import './Disparos.css';

function emptyForm() {
  return {
    name: '',
    channel: 'whatsapp',
    subject: '',
    emailDomainId: '',
    message: '',
    variants: [''],
    audienceType: 'all',
    audienceStatus: '',
    audienceListId: '',
    scheduleType: 'now',
    scheduledAt: '',
    recurringInterval: 'semanal',
    attachments: [],
    minDelaySeconds: 40,
    maxDelaySeconds: 100,
    batchSize: 15,
    batchPauseMinMinutes: 6,
    batchPauseMaxMinutes: 18
  };
}

const STATUS_LABELS = {
  agendado: 'Agendado',
  enviando: 'Enviando',
  concluido: 'Concluído',
  pausado: 'Pausado',
  falhou: 'Falhou'
};

const RECIPIENTS_PAGE_SIZE = 50;
const PROGRESS_POLL_MS = 10 * 1000;
const LIST_REFRESH_MS = 30 * 1000;
const RECIPIENT_STATUS_LABELS = {
  pendente: 'Pendente',
  enviado: 'Enviado',
  falhou: 'Falhou'
};

export default function Disparos() {
  const [broadcasts, setBroadcasts] = useState([]);
  const [lists, setLists] = useState([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [emailDomains, setEmailDomains] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [audienceCount, setAudienceCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [progressMap, setProgressMap] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [recipientsView, setRecipientsView] = useState({ items: [], total: 0 });
  const [recipientTab, setRecipientTab] = useState('enviado');
  const [recipientPage, setRecipientPage] = useState(1);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const fileInputRef = useRef(null);

  // Refs lidas dentro do polling, para o efeito não reiniciar a cada atualização.
  const broadcastsRef = useRef([]);
  const expandedRef = useRef(null);
  const recipientQueryRef = useRef({ tab: 'enviado', page: 1 });
  const lastProcessedRef = useRef({});

  const loadBroadcasts = useCallback(async () => {
    const { data } = await api.get('/broadcasts');
    broadcastsRef.current = data.broadcasts;
    setBroadcasts(data.broadcasts);
  }, []);

  // Acompanhamento paginado (50 por página) — nunca baixa o público inteiro.
  const loadRecipients = useCallback(async (id, tab, page, { silent = false } = {}) => {
    if (!silent) setLoadingRecipients(true);
    try {
      const { data } = await api.get(`/broadcasts/${id}/recipients`, {
        params: { status: tab, page, pageSize: RECIPIENTS_PAGE_SIZE }
      });
      setRecipientsView({ items: data.recipients, total: data.total });
    } catch (error) {
      if (!silent) alert(error.response?.data?.error || 'Não foi possível carregar os destinatários.');
    } finally {
      if (!silent) setLoadingRecipients(false);
    }
  }, []);

  const loadLists = useCallback(async () => {
    const { data } = await api.get('/lead-lists');
    setLists(data.lists);
  }, []);

  const loadConnections = useCallback(async () => {
    const { data } = await api.get('/whatsapp/connections');
    setConnectedCount(data.connections.filter((c) => c.status === 'conectado').length);
  }, []);

  const loadEmailDomains = useCallback(async () => {
    const { data } = await api.get('/email-domains');
    setEmailDomains(data.domains.filter((d) => d.isActive));
  }, []);

  useEffect(() => {
    loadBroadcasts();
    loadLists();
    loadConnections();
    loadEmailDomains();
  }, [loadBroadcasts, loadLists, loadConnections, loadEmailDomains]);

  useEffect(() => {
    expandedRef.current = expandedId;
  }, [expandedId]);

  useEffect(() => {
    recipientQueryRef.current = { tab: recipientTab, page: recipientPage };
  }, [recipientTab, recipientPage]);

  // A lista de disparos só é recarregada a cada 30 s e apenas com a aba visível
  // (serve para pegar disparos agendados que começaram sozinhos). O andamento
  // de um disparo em execução vem do polling de progresso abaixo.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadBroadcasts().catch(() => null);
    }, LIST_REFRESH_MS);

    function onVisible() {
      if (document.hidden) return;
      loadBroadcasts().catch(() => null);
      loadConnections().catch(() => null);
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadBroadcasts, loadConnections]);

  // Progresso: só dos disparos em execução (+ o expandido). A dependência é a
  // lista de IDs ativos — e não o array inteiro de disparos, que muda a cada
  // recarga e reiniciava este efeito (consultas em rajada).
  const activeKey = broadcasts
    .filter((b) => b.status === 'enviando')
    .map((b) => b.id)
    .sort()
    .join(',');

  useEffect(() => {
    const ids = new Set(activeKey ? activeKey.split(',') : []);
    if (expandedId) ids.add(expandedId);
    if (!ids.size) return undefined;

    let cancelled = false;

    async function pollOnce() {
      if (document.hidden) return;
      const results = await Promise.all(
        [...ids].map((id) =>
          api.get(`/broadcasts/${id}/progress`)
            .then((res) => [id, res.data.progress])
            .catch(() => [id, null])
        )
      );
      if (cancelled) return;

      setProgressMap((prev) => {
        const next = { ...prev };
        results.forEach(([id, progress]) => {
          if (progress) next[id] = progress;
        });
        return next;
      });

      // Status mudou (ex.: terminou ou foi pausado)? Atualiza a lista uma vez.
      const statusChanged = results.some(([id, progress]) => {
        const listed = broadcastsRef.current.find((b) => b.id === id);
        return progress && listed && listed.status !== progress.status;
      });
      if (statusChanged) loadBroadcasts().catch(() => null);

      // Houve novo envio no disparo aberto? Atualiza só a página visível.
      const openId = expandedRef.current;
      const openProgress = results.find(([id]) => id === openId)?.[1];
      if (openProgress) {
        const processed = openProgress.sent + openProgress.failed;
        if (lastProcessedRef.current[openId] !== processed) {
          lastProcessedRef.current[openId] = processed;
          const { tab, page } = recipientQueryRef.current;
          loadRecipients(openId, tab, page, { silent: true });
        }
      }
    }

    pollOnce();
    // Só repete enquanto houver disparo em execução.
    const interval = activeKey ? setInterval(pollOnce, PROGRESS_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [activeKey, expandedId, loadBroadcasts, loadRecipients]);

  function buildAudienceFilter() {
    if (form.audienceType === 'list' && form.audienceListId) return { listId: form.audienceListId };
    if (form.audienceType === 'status' && form.audienceStatus) return { status: form.audienceStatus };
    return { all: true };
  }

  async function handlePreviewAudience() {
    try {
      const { data } = await api.post('/broadcasts/preview-audience', {
        audienceFilter: buildAudienceFilter(),
        channel: form.channel
      });
      setAudienceCount(data.count);
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível calcular o público.');
    }
  }

  function updateVariant(index, value) {
    setForm((prev) => {
      const variants = [...prev.variants];
      variants[index] = value;
      return { ...prev, variants };
    });
  }

  function addVariant() {
    setForm((prev) => prev.variants.length >= 12 ? prev : { ...prev, variants: [...prev.variants, ''] });
  }

  function removeVariant(index) {
    setForm((prev) => ({ ...prev, variants: prev.variants.filter((_, i) => i !== index) }));
  }

  function handleChannelChange(channel) {
    setForm((prev) => ({
      ...prev,
      channel,
      attachments: channel === 'whatsapp' ? prev.attachments.slice(0, 1) : prev.attachments
    }));
    setAudienceCount(null);
  }

  function handleAttachmentsChange(e) {
    const chosen = Array.from(e.target.files || []);
    const valid = [];

    const maxBytes = (form.channel === 'whatsapp' ? 16 : 10) * 1024 * 1024;
    for (const file of chosen) {
      if (file.size > maxBytes) {
        alert(`O arquivo ${file.name} ultrapassa o limite de ${form.channel === 'whatsapp' ? 16 : 10} MB.`);
        continue;
      }
      if (!ATTACHMENT_REGEX.test(file.type || '') || BLOCKED_EXT_REGEX.test(file.name)) {
        alert(`Formato não permitido: ${file.name}. Use foto (JPG, PNG, WebP), vídeo MP4, PDF, Word, Excel, PowerPoint, TXT, CSV ou ZIP.`);
        continue;
      }
      valid.push(file);
    }

    setForm((prev) => ({
      ...prev,
      attachments: form.channel === 'whatsapp'
        ? valid.slice(0, 1)
        : [...prev.attachments, ...valid].slice(0, 5)
    }));

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeAttachment(index) {
    setForm((prev) => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index) }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);

    const cleanVariants = form.variants.map((v) => v.trim()).filter(Boolean);
    if (form.channel === 'whatsapp' && !cleanVariants.length) {
      alert('Informe pelo menos uma variação de mensagem.');
      setSaving(false);
      return;
    }

    const formData = new FormData();
    formData.append('name', form.name);
    formData.append('channel', form.channel);
    formData.append('variants', JSON.stringify(cleanVariants));
    if (form.channel === 'email') {
      formData.append('subject', form.subject);
      if (form.emailDomainId) formData.append('emailDomainId', form.emailDomainId);
    }
    if (form.channel !== 'whatsapp') formData.append('message', form.message);
    if (form.channel === 'whatsapp') {
      formData.append('minDelaySeconds', String(form.minDelaySeconds));
      formData.append('maxDelaySeconds', String(form.maxDelaySeconds));
      formData.append('batchSize', String(form.batchSize));
      formData.append('batchPauseMinMinutes', String(form.batchPauseMinMinutes));
      formData.append('batchPauseMaxMinutes', String(form.batchPauseMaxMinutes));
    }
    formData.append('audienceFilter', JSON.stringify(buildAudienceFilter()));
    formData.append('scheduleType', form.scheduleType);
    if (form.scheduleType === 'scheduled') formData.append('scheduledAt', form.scheduledAt);
    if (form.scheduleType === 'recurring') formData.append('recurringInterval', form.recurringInterval);
    form.attachments.forEach((file) => formData.append('attachments', file));

    try {
      await api.post('/broadcasts', formData);
      setShowModal(false);
      setForm(emptyForm());
      setAudienceCount(null);
      await loadBroadcasts();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar disparo');
    } finally {
      setSaving(false);
    }
  }

  async function handlePauseResume(id) {
    try {
      await api.post(`/broadcasts/${id}/pause-resume`);
      await loadBroadcasts();
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível alterar o estado do disparo.');
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Excluir este disparo?')) return;
    try {
      await api.delete(`/broadcasts/${id}`);
      if (expandedId === id) setExpandedId(null);
      await loadBroadcasts();
    } catch (error) {
      alert(error.response?.data?.error || 'Não foi possível excluir o disparo.');
    }
  }

  async function toggleExpanded(id) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(id);
    setRecipientTab('enviado');
    setRecipientPage(1);
    setRecipientsView({ items: [], total: 0 });
    lastProcessedRef.current[id] = undefined;
    loadRecipients(id, 'enviado', 1);
  }

  function changeRecipientTab(tab) {
    setRecipientTab(tab);
    setRecipientPage(1);
    loadRecipients(expandedId, tab, 1);
  }

  function changeRecipientPage(page) {
    setRecipientPage(page);
    loadRecipients(expandedId, recipientTab, page);
  }

  function getProgress(broadcast) {
    return progressMap[broadcast.id] || {
      audienceTotal: 0,
      sent: 0,
      failed: 0,
      pending: 0,
      percentComplete: 0,
      runningNote: broadcast.runningNote
    };
  }

  function openCreate() {
    setForm(emptyForm());
    setAudienceCount(null);
    setShowModal(true);
  }

  return (
    <div className="disparos-page">
      <header>
        <h1>Disparos em Massa</h1>
        <p>
          Crie campanhas, anexe foto, vídeo ou PDF no WhatsApp, acompanhe cada lead e retome um disparo interrompido
          sem refazer a configuração. Os contatos que já foram enviados permanecem registrados.
        </p>
      </header>

      <div className="disparos-toolbar">
        <button className="btn-primary" onClick={openCreate}>➕ Novo Disparo</button>
        <span className="connection-indicator">WhatsApp conectado: <strong>{connectedCount}</strong></span>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Canal</th>
              <th>Agenda</th>
              <th>Status</th>
              <th>Progresso</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.map((b) => {
              const progress = getProgress(b);
              const canPause = ['agendado', 'enviando'].includes(b.status);
              const canResume = b.status === 'pausado';

              return (
                <Fragment key={b.id}>
                  <tr>
                    <td>
                      <strong>{b.name}</strong>
                      {Array.isArray(b.attachments) && b.attachments.length > 0 && <span className="attachment-badge">📎 anexo</span>}
                    </td>
                    <td>{b.channel === 'email' ? '📧 E-mail' : b.channel === 'whatsapp' ? '💬 WhatsApp' : '📱 SMS'}</td>
                    <td>
                      {b.scheduleType === 'now' && 'Imediato'}
                      {b.scheduleType === 'scheduled' && `Em ${new Date(b.scheduledAt).toLocaleString('pt-BR')}`}
                      {b.scheduleType === 'recurring' && `A cada ${b.recurringInterval}`}
                    </td>
                    <td><span className={`status-tag status-${b.status}`}>{STATUS_LABELS[b.status] || b.status}</span></td>
                    <td>
                      <div className="progress-cell">
                        <div className="progress-bar-track">
                          <div className="progress-bar-fill" style={{ width: `${progress.percentComplete}%` }} />
                        </div>
                        <span className="progress-cell-text">
                          {progress.sent} enviados · {progress.failed} falhas · {progress.pending} pendentes
                        </span>
                      </div>
                      <button type="button" className="btn-link-small" onClick={() => toggleExpanded(b.id)}>
                        {expandedId === b.id ? 'ocultar acompanhamento' : 'acompanhar disparos'}
                      </button>
                    </td>
                    <td>
                      {(canPause || canResume) && (
                        <button className="btn-outline" onClick={() => handlePauseResume(b.id)}>
                          {canResume ? '▶ Retomar' : '⏸ Pausar'}
                        </button>
                      )}
                      <button className="btn-danger-small" onClick={() => handleDelete(b.id)}>Excluir</button>
                    </td>
                  </tr>

                  {expandedId === b.id && (
                    <tr className="details-row">
                      <td colSpan={6}>
                        <div className="details-panel">
                          <div className="progress-summary">
                            <span><strong>Total:</strong> {progress.audienceTotal}</span>
                            <span className="summary-success"><strong>✓ Enviados:</strong> {progress.sent}</span>
                            <span className="summary-danger"><strong>✕ Falhas:</strong> {progress.failed}</span>
                            <span className="summary-pending"><strong>⏳ Pendentes:</strong> {progress.pending}</span>
                            <span><strong>Progresso:</strong> {progress.percentComplete}%</span>
                          </div>
                          {progress.runningNote && <div className="details-note">ℹ️ {progress.runningNote}</div>}
                          {(progress.lastContact || progress.nextContact) && (
                            <div className="details-note">
                              {progress.lastContact && (
                                <span>
                                  <strong>Último enviado:</strong> {progress.lastContact.name || progress.lastContact.phone || '-'}
                                  {progress.lastContact.sentAt ? ` (${new Date(progress.lastContact.sentAt).toLocaleString('pt-BR')})` : ''}
                                </span>
                              )}
                              {progress.lastContact && progress.nextContact && ' · '}
                              {progress.nextContact && (
                                <span>
                                  <strong>{progress.status === 'enviando' ? 'Próximo:' : 'Retoma em:'}</strong>{' '}
                                  {progress.nextContact.name || progress.nextContact.phone || progress.nextContact.email || '-'}
                                </span>
                              )}
                            </div>
                          )}

                          <div className="recipient-tabs">
                            {[
                              ['enviado', `✓ Enviados (${progress.sent})`],
                              ['falhou', `✕ Falhas (${progress.failed})`],
                              ['pendente', `⏳ Não enviados (${progress.pending})`]
                            ].map(([tab, label]) => (
                              <button
                                key={tab}
                                type="button"
                                className={recipientTab === tab ? 'btn-primary' : 'btn-outline'}
                                onClick={() => changeRecipientTab(tab)}
                              >
                                {label}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="btn-outline"
                              onClick={() => loadRecipients(b.id, recipientTab, recipientPage)}
                            >
                              ↻ Atualizar
                            </button>
                          </div>

                          {loadingRecipients && <p className="hint-text">Carregando…</p>}

                          {!loadingRecipients && (
                            <div className="recipient-table-wrap">
                              <table className="recipient-table">
                                <thead>
                                  <tr><th>Lead</th><th>Telefone</th><th>Status</th><th>Horário</th><th>Erro</th></tr>
                                </thead>
                                <tbody>
                                  {recipientsView.items.map((r, index) => (
                                    <tr key={r.leadId}>
                                      <td>
                                        {r.status === 'pendente' && recipientPage === 1 && index === 0 && (
                                          <span title="Próximo contato a receber">▶ </span>
                                        )}
                                        {r.name || '-'}
                                      </td>
                                      <td>{r.phone || '-'}</td>
                                      <td><span className={`recipient-status recipient-${r.status}`}>{RECIPIENT_STATUS_LABELS[r.status] || r.status}</span></td>
                                      <td>{r.sentAt ? new Date(r.sentAt).toLocaleString('pt-BR') : '-'}</td>
                                      <td className="recipient-error">{r.errorMessage || '-'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {recipientsView.items.length === 0 && <p className="hint-text">Nenhum contato nesta aba.</p>}
                            </div>
                          )}

                          {recipientsView.total > RECIPIENTS_PAGE_SIZE && (
                            <div className="recipient-pagination">
                              <button
                                type="button"
                                className="btn-outline"
                                disabled={recipientPage <= 1 || loadingRecipients}
                                onClick={() => changeRecipientPage(recipientPage - 1)}
                              >
                                ← Anterior
                              </button>
                              <span className="hint-text">
                                Página {recipientPage} de {Math.ceil(recipientsView.total / RECIPIENTS_PAGE_SIZE)} · {recipientsView.total} contatos
                              </span>
                              <button
                                type="button"
                                className="btn-outline"
                                disabled={recipientPage >= Math.ceil(recipientsView.total / RECIPIENTS_PAGE_SIZE) || loadingRecipients}
                                onClick={() => changeRecipientPage(recipientPage + 1)}
                              >
                                Próxima →
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {broadcasts.length === 0 && <tr><td colSpan={6} className="empty-state">Nenhum disparo criado ainda</td></tr>}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
            <h2>Novo Disparo</h2>

            <form onSubmit={handleCreate}>
              <label>Nome interno do disparo</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />

              <label>Canal</label>
              <select value={form.channel} onChange={(e) => handleChannelChange(e.target.value)}>
                <option value="whatsapp">💬 WhatsApp</option>
                <option value="email">📧 E-mail</option>
                <option value="sms">📱 SMS</option>
              </select>

              {form.channel === 'whatsapp' && (
                <>
                  <p className="hint-text">
                    {connectedCount === 0
                      ? '⚠️ Nenhum WhatsApp conectado. Você pode salvar a campanha e conectá-lo antes de Retomar.'
                      : `${connectedCount} número(s) conectado(s).`}
                  </p>

                  <label>Variações de mensagem (até 12 — use {'{{nome}}'} para personalizar)</label>
                  {form.variants.map((variant, index) => (
                    <div className="variant-row" key={index}>
                      <textarea
                        rows={3}
                        placeholder={`Variação ${index + 1}`}
                        value={variant}
                        onChange={(e) => updateVariant(index, e.target.value)}
                      />
                      {form.variants.length > 1 && (
                        <button type="button" className="btn-danger-small" onClick={() => removeVariant(index)}>Remover</button>
                      )}
                    </div>
                  ))}
                  {form.variants.length < 12 && (
                    <button type="button" className="btn-outline" onClick={addVariant}>➕ Adicionar variação</button>
                  )}

                  <fieldset className="antiban-fieldset">
                    <legend>Intervalos de envio</legend>
                    <p className="hint-text">Os valores são aplicados entre mensagens e as pausas longas preservam o andamento da campanha.</p>
                    <div className="antiban-grid">
                      <div>
                        <label>Mínimo entre mensagens (segundos)</label>
                        <input type="number" min={20} max={600} value={form.minDelaySeconds} onChange={(e) => setForm({ ...form, minDelaySeconds: e.target.value })} />
                      </div>
                      <div>
                        <label>Máximo entre mensagens (segundos)</label>
                        <input type="number" min={20} max={900} value={form.maxDelaySeconds} onChange={(e) => setForm({ ...form, maxDelaySeconds: e.target.value })} />
                      </div>
                      <div>
                        <label>Mensagens por lote</label>
                        <input type="number" min={5} max={60} value={form.batchSize} onChange={(e) => setForm({ ...form, batchSize: e.target.value })} />
                      </div>
                      <div>
                        <label>Pausa mínima (minutos)</label>
                        <input type="number" min={1} max={60} value={form.batchPauseMinMinutes} onChange={(e) => setForm({ ...form, batchPauseMinMinutes: e.target.value })} />
                      </div>
                      <div>
                        <label>Pausa máxima (minutos)</label>
                        <input type="number" min={1} max={120} value={form.batchPauseMaxMinutes} onChange={(e) => setForm({ ...form, batchPauseMaxMinutes: e.target.value })} />
                      </div>
                    </div>
                  </fieldset>
                </>
              )}

              {form.channel === 'email' && (
                <>
                  {emailDomains.length > 1 && (
                    <>
                      <label>Enviar como</label>
                      <select value={form.emailDomainId} onChange={(e) => setForm({ ...form, emailDomainId: e.target.value })}>
                        <option value="">Domínio padrão (definido em Configurações)</option>
                        {emailDomains.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.fromName ? `${d.fromName} <${d.fromEmail}>` : d.fromEmail || d.domain}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <label>Assunto do e-mail</label>
                  <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
                  <label>Mensagem</label>
                  <textarea rows={5} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required />
                </>
              )}

              {form.channel === 'sms' && (
                <>
                  <label>Mensagem</label>
                  <textarea rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required />
                </>
              )}

              {(form.channel === 'whatsapp' || form.channel === 'email') && (
                <div className="image-upload-box">
                  <label>{form.channel === 'whatsapp' ? 'Foto, vídeo ou documento para acompanhar a mensagem (opcional)' : 'Anexos (opcional)'}</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ATTACHMENT_ACCEPT}
                    multiple={form.channel !== 'whatsapp'}
                    onChange={handleAttachmentsChange}
                  />
                  <p className="hint-text">
                    {form.channel === 'whatsapp'
                      ? 'WhatsApp: 1 arquivo (foto JPG/PNG/WebP, vídeo MP4, PDF, Word, Excel...), até 16 MB. A mensagem vai como legenda.'
                      : 'Até 5 arquivos (fotos, PDF, Word, Excel...), 10 MB cada.'}
                  </p>

                  {form.attachments.length > 0 && (
                    <ul className="attachments-list">
                      {form.attachments.map((file, index) => (
                        <li key={`${file.name}-${index}`}>
                          <span>{file.type.startsWith('image/') ? '🖼️' : '📄'} {file.name}</span>
                          <button type="button" className="btn-link-small" onClick={() => removeAttachment(index)}>remover</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <label>Público-alvo</label>
              <select value={form.audienceType} onChange={(e) => setForm({ ...form, audienceType: e.target.value })}>
                <option value="all">Todos os leads</option>
                <option value="status">Por status do funil</option>
                <option value="list">Por Lista de Leads</option>
              </select>

              {form.audienceType === 'status' && (
                <select value={form.audienceStatus} onChange={(e) => setForm({ ...form, audienceStatus: e.target.value })} required>
                  <option value="">Selecione um status</option>
                  <option value="novo">Novo</option>
                  <option value="qualificado">Qualificado</option>
                  <option value="em_negociacao">Em negociação</option>
                  <option value="fechado">Fechado</option>
                  <option value="desqualificado">Desqualificado</option>
                </select>
              )}

              {form.audienceType === 'list' && (
                <select value={form.audienceListId} onChange={(e) => setForm({ ...form, audienceListId: e.target.value })} required>
                  <option value="">Selecione uma lista</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({l.type === 'dynamic' ? 'dinâmica' : 'estática'})</option>
                  ))}
                </select>
              )}

              <button type="button" className="btn-outline" onClick={handlePreviewAudience}>Ver tamanho do público</button>
              {audienceCount !== null && <p className="hint-text">Público elegível: <strong>{audienceCount}</strong> lead(s).</p>}

              <label>Quando enviar?</label>
              <select value={form.scheduleType} onChange={(e) => setForm({ ...form, scheduleType: e.target.value })}>
                <option value="now">Agora</option>
                <option value="scheduled">Agendar</option>
                <option value="recurring">Recorrente</option>
              </select>

              {form.scheduleType === 'scheduled' && (
                <>
                  <label>Data e hora do envio</label>
                  <input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} required />
                </>
              )}

              {form.scheduleType === 'recurring' && (
                <>
                  <label>Repetir a cada</label>
                  <select value={form.recurringInterval} onChange={(e) => setForm({ ...form, recurringInterval: e.target.value })}>
                    <option value="diario">Dia</option>
                    <option value="semanal">Semana</option>
                    <option value="mensal">Mês</option>
                  </select>
                </>
              )}

              <div className="modal-actions">
                <button type="button" className="btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Criar disparo'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}