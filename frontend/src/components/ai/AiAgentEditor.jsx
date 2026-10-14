// frontend/src/components/ai/AiAgentEditor.jsx
//
// Tela de configuração do agente de voz: quem ele é, o que sabe do mercado
// (glossário técnico), o catálogo, como qualifica e quando chama o vendedor.
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { aiProviderLabel } from '../../utils/aiProviders';

const EMPTY = {
  name: '',
  market: 'generico',
  companyName: '',
  agentName: 'Júlia',
  voice: 'Polly.Camila-Neural',
  objective: '',
  openingScript: '',
  extraInstructions: '',
  handoffCriteria: '',
  glossary: [],
  qualificationFields: [],
  catalogText: '',
  catalogUrl: '',
  handoffMode: 'whatsapp',
  handoffPhone: '',
  handoffAgentId: '',
  notifySellerWhatsapp: true,
  leadWhatsappMessage: '',
  crmColumnId: '',
  aiProvider: '',
  maxTurns: 14,
  maxCallSeconds: 420,
  recordCalls: false
};

function fromPreset(preset) {
  return {
    market: preset.market,
    objective: preset.objective,
    openingScript: preset.openingScript,
    extraInstructions: preset.extraInstructions || '',
    handoffCriteria: preset.handoffCriteria,
    glossary: preset.glossary.map((g) => ({ ...g })),
    qualificationFields: preset.qualificationFields.map((f) => ({ ...f })),
    leadWhatsappMessage: preset.leadWhatsappMessage || ''
  };
}

export default function AiAgentEditor({ agentId, options, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!!agentId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [presetId, setPresetId] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [catalogMsg, setCatalogMsg] = useState('');
  const [reading, setReading] = useState(false);
  const [catalogInfo, setCatalogInfo] = useState(null);
  const [libraryVoices, setLibraryVoices] = useState([]);
  const [voiceMsg, setVoiceMsg] = useState('');
  const [previewing, setPreviewing] = useState(false);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (agentId) {
      api
        .get(`/ai-calls/agents/${agentId}`)
        .then(({ data }) => {
          const a = data.agent;
          setForm({
            ...EMPTY,
            ...a,
            extraInstructions: a.extraInstructions || '',
            catalogText: a.catalogText || '',
            catalogUrl: a.catalogUrl || '',
            handoffPhone: a.handoffPhone || '',
            handoffAgentId: a.handoffAgentId || '',
            leadWhatsappMessage: a.leadWhatsappMessage || '',
            crmColumnId: a.crmColumnId || '',
            aiProvider: a.aiProvider || '',
            glossary: Array.isArray(a.glossary) ? a.glossary : [],
            qualificationFields: Array.isArray(a.qualificationFields) ? a.qualificationFields : []
          });
          setCatalogInfo({ fetchedAt: a.catalogFetchedAt, chars: (a.catalogWebText || '').length });
        })
        .catch((err) => setError(err.response?.data?.error || 'Não foi possível carregar o agente.'))
        .finally(() => setLoading(false));
    } else {
      const generic = options.presets.find((p) => p.id === 'generico');
      if (generic) setForm({ ...EMPTY, ...fromPreset(generic) });
    }
  }, [agentId, options.presets]);

  function applyPreset() {
    const preset = options.presets.find((p) => p.id === presetId);
    if (!preset) return;
    if (!window.confirm('Aplicar este modelo vai substituir objetivo, abertura, glossário e qualificação. Continuar?')) return;
    set(fromPreset(preset));
  }

  const allVoices = [...options.voices, ...libraryVoices];
  const groupedVoices = allVoices.reduce((acc, v) => {
    const g = v.group || 'Outras';
    (acc[g] = acc[g] || []).push(v);
    return acc;
  }, {});

  async function loadLibraryVoices() {
    setVoiceMsg('Buscando vozes em português do Brasil…');
    try {
      const { data } = await api.get('/ai-calls/voices/library');
      setLibraryVoices(data.voices || []);
      setVoiceMsg(data.voices?.length ? `${data.voices.length} voz(es) pt-BR adicionada(s) à lista.` : 'Nenhuma voz encontrada (confira a chave do Gemini em Configurações).');
    } catch (error) {
      setVoiceMsg(error.response?.data?.error || 'Não foi possível buscar as vozes.');
    }
  }

  async function previewVoice() {
    setPreviewing(true);
    setVoiceMsg('Gerando amostra…');
    try {
      const { data } = await api.post('/ai-calls/voices/preview', { voice: form.voice, agentId: agentId || undefined, glossary: form.glossary, text: (form.openingScript || '').slice(0, 300) || undefined }, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setVoiceMsg('');
    } catch (error) {
      let message = 'Não foi possível gerar a amostra.';
      try {
        const text = await error.response?.data?.text?.();
        message = JSON.parse(text).error || message;
      } catch (_) { /* mantém a mensagem padrão */ }
      setVoiceMsg(message);
    }
    setPreviewing(false);
  }

  function importBulk() {
    const added = bulkText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [term, ...rest] = line.split(/\s*[:–—-]\s+|\s*:\s*/);
        return { term: (term || '').trim(), meaning: rest.join(' - ').trim() };
      })
      .filter((g) => g.term);
    set({ glossary: [...form.glossary, ...added] });
    setBulkText('');
    setBulkOpen(false);
  }

  async function readSite() {
    setReading(true);
    setCatalogMsg('');
    try {
      const { data } = await api.post(`/ai-calls/agents/${agentId}/refresh-catalog`);
      setCatalogMsg(`✅ Site lido: ${data.pages} página(s), ${data.chars.toLocaleString('pt-BR')} caracteres.`);
      setCatalogInfo({ fetchedAt: new Date().toISOString(), chars: data.chars });
    } catch (err) {
      setCatalogMsg(`❌ ${err.response?.data?.error || 'Não foi possível ler o site.'}`);
    } finally {
      setReading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form };
      if (agentId) await api.put(`/ai-calls/agents/${agentId}`, payload);
      else await api.post('/ai-calls/agents', payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível salvar o agente.');
    } finally {
      setSaving(false);
    }
  }

  const updateRow = (key, index, patch) =>
    set({ [key]: form[key].map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const removeRow = (key, index) => set({ [key]: form[key].filter((_, i) => i !== index) });

  if (loading) {
    return (
      <div className="ia-backdrop">
        <div className="ia-modal"><p className="ia-muted">Carregando…</p></div>
      </div>
    );
  }

  return (
    <div className="ia-backdrop" onClick={onClose}>
      <div className="ia-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ia-modal-head">
          <h2>{agentId ? 'Editar agente de voz IA' : 'Novo agente de voz IA'}</h2>
          <button type="button" className="ia-x" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSave}>
          {!agentId && (
            <div className="ia-preset">
              <label>Começar com um modelo pronto de mercado</label>
              <div className="ia-row">
                <select className="ia-grow" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                  <option value="">Escolha um modelo…</option>
                  {options.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <button type="button" className="ia-btn ia-btn-light" disabled={!presetId} onClick={applyPreset}>Aplicar modelo</button>
              </div>
              <small className="ia-muted">O modelo já traz roteiro, glossário técnico e perguntas de qualificação. Você pode editar tudo depois.</small>
            </div>
          )}

          <details open className="ia-section">
            <summary>1) Identidade</summary>
            <div className="ia-grid">
              <div><label>Nome deste agente (só para você)</label><input value={form.name} onChange={(e) => set({ name: e.target.value })} required placeholder="Ex.: Prospecção de estúdios" /></div>
              <div><label>Nome da sua empresa (como a IA se apresenta)</label><input value={form.companyName} onChange={(e) => set({ companyName: e.target.value })} required placeholder="Ex.: Piercing Express" /></div>
              <div><label>Nome da assistente virtual</label><input value={form.agentName} onChange={(e) => set({ agentName: e.target.value })} placeholder="Júlia" /></div>
              <div>
                <label>Voz</label>
                <select value={allVoices.some((v) => v.id === form.voice) ? form.voice : '__custom'} onChange={(e) => e.target.value !== '__custom' && set({ voice: e.target.value })}>
                  {Object.entries(groupedVoices).map(([group, list]) => (
                    <optgroup key={group} label={group}>
                      {list.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </optgroup>
                  ))}
                  <option value="__custom">Outra (digite abaixo)</option>
                </select>
                {!allVoices.some((v) => v.id === form.voice) && (
                  <input style={{ marginTop: 6 }} value={form.voice} onChange={(e) => set({ voice: e.target.value })} placeholder="Ex.: Google.pt-BR-Neural2-A ou gemini:Kore" />
                )}
                <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="ia-btn ia-btn-light" onClick={previewVoice} disabled={previewing} title="Ouvir a voz escolhida">
                    ▶ Ouvir amostra
                  </button>
                  <button type="button" className="ia-btn ia-btn-light" onClick={loadLibraryVoices}>Mais vozes pt-BR (Gemini)</button>
                </div>
                {voiceMsg && <p className="ia-muted">{voiceMsg}</p>}
                <p className="ia-muted">
                  As vozes do <strong>Gemini</strong> são as mais naturais (usam a chave do Gemini de Configurações; se falharem, a ligação
                  segue com a voz Polly). As vozes <strong>Google Chirp 3 HD</strong> são tocadas direto pela Twilio.
                </p>
              </div>
            </div>
          </details>

          <details open className="ia-section">
            <summary>2) Roteiro da ligação</summary>
            <label>Objetivo da ligação</label>
            <textarea rows={3} value={form.objective} onChange={(e) => set({ objective: e.target.value })} required />
            <label>Fala de abertura <small>(use {'{{nome}}'}, {'{{empresa}}'} e {'{{agente}}'})</small></label>
            <textarea rows={3} value={form.openingScript} onChange={(e) => set({ openingScript: e.target.value })} required />
            <small className="ia-muted">Mantenha a apresentação como “assistente virtual”: é transparente com o cliente e evita problemas.</small>
            <label>Instruções extras (política de preço, o que nunca dizer, tom…)</label>
            <textarea rows={3} value={form.extraInstructions} onChange={(e) => set({ extraInstructions: e.target.value })} />
          </details>

          <details open className="ia-section">
            <summary>3) Treinamento do mercado — termos técnicos</summary>
            <p className="ia-muted">A IA usa estes termos corretamente e o reconhecimento de voz passa a entendê-los melhor ao telefone ({form.glossary.length} termo(s)). Se a voz pronunciar algum termo ou o nome da empresa errado, preencha "Como falar" escrevendo do jeito que se lê em português (ex.: Piercing → Pírsin).</p>
            {form.glossary.map((g, index) => (
              <div className="ia-row ia-gloss-row" key={index}>
                <input value={g.term} onChange={(e) => updateRow('glossary', index, { term: e.target.value })} placeholder="Termo (ex.: threadless)" />
                <input className="ia-grow" value={g.meaning} onChange={(e) => updateRow('glossary', index, { meaning: e.target.value })} placeholder="O que significa" />
                <input value={g.pronunciation || ''} onChange={(e) => updateRow('glossary', index, { pronunciation: e.target.value })} placeholder="Como falar (ex.: Pírsin)" title="Escreva como se lê em português, para a voz pronunciar certo" />
                <button type="button" className="ia-x" onClick={() => removeRow('glossary', index)}>✕</button>
              </div>
            ))}
            <div className="ia-row">
              <button type="button" className="ia-btn ia-btn-light" onClick={() => set({ glossary: [...form.glossary, { term: '', meaning: '' }] })}>+ Adicionar termo</button>
              <button type="button" className="ia-btn ia-btn-light" onClick={() => setBulkOpen(!bulkOpen)}>Colar lista de termos</button>
            </div>
            {bulkOpen && (
              <div>
                <textarea rows={5} value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={'Um por linha, no formato:\nlabret: haste reta com disco de fundo plano\nclicker - argola com dobradiça'} />
                <button type="button" className="ia-btn ia-btn-primary" onClick={importBulk}>Importar</button>
              </div>
            )}
          </details>

          <details open className="ia-section">
            <summary>4) Qualificação — o que a IA precisa descobrir</summary>
            {form.qualificationFields.map((f, index) => (
              <div className="ia-row" key={index}>
                <input className="ia-grow" value={f.label} onChange={(e) => updateRow('qualificationFields', index, { label: e.target.value })} placeholder="Ex.: Quantas joias compra por mês?" />
                <label className="ia-check"><input type="checkbox" checked={!!f.required} onChange={(e) => updateRow('qualificationFields', index, { required: e.target.checked })} /> obrigatório</label>
                <button type="button" className="ia-x" onClick={() => removeRow('qualificationFields', index)}>✕</button>
              </div>
            ))}
            <button type="button" className="ia-btn ia-btn-light" onClick={() => set({ qualificationFields: [...form.qualificationFields, { label: '', required: false }] })}>+ Adicionar pergunta</button>
            <label>Quando a IA deve chamar o vendedor</label>
            <textarea rows={3} value={form.handoffCriteria} onChange={(e) => set({ handoffCriteria: e.target.value })} required />
          </details>

          <details open className="ia-section">
            <summary>5) Produtos / catálogo</summary>
            <p className="ia-muted">A IA só fala de produtos, preços e condições que estiverem aqui. Se não estiver, ela diz que o consultor confirma.</p>
            <label>Catálogo em texto (cole produtos, medidas, preços, condições de atacado)</label>
            <textarea rows={7} value={form.catalogText} onChange={(e) => set({ catalogText: e.target.value })} placeholder={'Labret titânio ASTM F136 16g — R$ 12,00 (atacado a partir de 20 un.)\nArgola clicker aço 316L 1,2 mm — R$ 18,00\n…'} />
            <small className="ia-muted">{form.catalogText.length.toLocaleString('pt-BR')} / 60.000 caracteres</small>
            <label>Site com os produtos (opcional)</label>
            <div className="ia-row">
              <input className="ia-grow" value={form.catalogUrl} onChange={(e) => set({ catalogUrl: e.target.value })} placeholder="https://www.seusite.com.br" />
              <button type="button" className="ia-btn ia-btn-light" disabled={!agentId || !form.catalogUrl || reading} onClick={readSite}>
                {reading ? 'Lendo…' : 'Ler site agora'}
              </button>
            </div>
            {!agentId && <small className="ia-muted">Salve o agente primeiro para ler o site. Nas campanhas o site é atualizado sozinho a cada 24 horas.</small>}
            {catalogInfo?.fetchedAt && <small className="ia-muted">Última leitura do site: {new Date(catalogInfo.fetchedAt).toLocaleString('pt-BR')} ({catalogInfo.chars.toLocaleString('pt-BR')} caracteres)</small>}
            {catalogMsg && <p className="ia-note">{catalogMsg}</p>}
          </details>

          <details open className="ia-section">
            <summary>6) Passagem para o vendedor (modelo híbrido)</summary>
            <label>Quando o cliente estiver pronto, a IA vai…</label>
            <div className="ia-radio">
              <label><input type="radio" name="handoffMode" checked={form.handoffMode === 'whatsapp'} onChange={() => set({ handoffMode: 'whatsapp' })} /> 💬 Enviar o contato para o vendedor no WhatsApp <small>(e o vendedor chama o cliente)</small></label>
              <label><input type="radio" name="handoffMode" checked={form.handoffMode === 'transfer'} onChange={() => set({ handoffMode: 'transfer' })} /> 📞 Transferir a ligação ao vivo para o vendedor <small>(se ele não atender, o contato vai por WhatsApp e o card fica vermelho no CRM)</small></label>
            </div>
            <div className="ia-grid">
              <div>
                <label>Telefone do vendedor {form.handoffMode === 'transfer' ? '*' : ''}</label>
                <input value={form.handoffPhone} onChange={(e) => set({ handoffPhone: e.target.value })} placeholder="11 99999-8888" />
              </div>
              <div>
                <label>…ou escolha um vendedor cadastrado</label>
                <select value={form.handoffAgentId} onChange={(e) => set({ handoffAgentId: e.target.value })}>
                  <option value="">Usar o telefone ao lado</option>
                  {options.sellers.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.phoneNumber}</option>)}
                </select>
              </div>
            </div>
            <label className="ia-check"><input type="checkbox" checked={form.notifySellerWhatsapp} onChange={(e) => set({ notifySellerWhatsapp: e.target.checked })} /> Avisar o vendedor por WhatsApp com o resumo da conversa e as informações coletadas</label>
            <label>Mensagem de WhatsApp para o cliente (leads quentes sem transferência e mornos) <small>— deixe vazio para não enviar</small></label>
            <textarea rows={3} value={form.leadWhatsappMessage} onChange={(e) => set({ leadWhatsappMessage: e.target.value })} />
            <label>Mover o lead quente no CRM para</label>
            <select value={form.crmColumnId} onChange={(e) => set({ crmColumnId: e.target.value })}>
              <option value="">Coluna “Qualificado” (padrão)</option>
              {options.crmColumns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </details>

          <details className="ia-section">
            <summary>7) Avançado</summary>
            <div className="ia-grid">
              <div>
                <label>IA usada nas ligações</label>
                <select value={form.aiProvider} onChange={(e) => set({ aiProvider: e.target.value })}>
                  <option value="">A configurada na conta (padrão)</option>
                  {options.aiProviders.map((p) => <option key={p} value={p}>{aiProviderLabel(p)}</option>)}
                </select>
              </div>
              <div><label>Máximo de falas da IA por ligação</label><input type="number" min="4" max="30" value={form.maxTurns} onChange={(e) => set({ maxTurns: e.target.value })} /></div>
              <div><label>Duração máxima da ligação (segundos)</label><input type="number" min="60" max="900" value={form.maxCallSeconds} onChange={(e) => set({ maxCallSeconds: e.target.value })} /></div>
            </div>
            <label className="ia-check"><input type="checkbox" checked={form.recordCalls} onChange={(e) => set({ recordCalls: e.target.checked })} /> Gravar as ligações (a IA avisa “esta ligação pode ser gravada”)</label>
          </details>

          {error && <p className="ia-error">{error}</p>}
          <div className="ia-modal-actions">
            <button type="button" className="ia-btn ia-btn-light" onClick={onClose}>Cancelar</button>
            <button type="submit" className="ia-btn ia-btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar agente'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
