// frontend/src/pages/Configuracoes.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import { AI_PROVIDERS, aiProviderLabel } from '../utils/aiProviders';
import './Configuracoes.css';

const CATEGORY_LABELS = {
  telephony: '📞 Telefonia',
  ai_telephony: '☎️ Telefonia da IA',
  email: '📧 E-mail',
  ai: '🤖 Inteligência Artificial',
  leadsearch: '🔍 Busca de empresas',
  dialer: '📟 Discador'
};

export default function Configuracoes() {
  const [telephony, setTelephony] = useState({ accountSid: '', authToken: '' });
  // Operadora das ligações do Agente de IA (alternativa à Twilio)
  const [aiTelProvider, setAiTelProvider] = useState('twilio');
  const [telnyx, setTelnyx] = useState({ apiKey: '', applicationSid: '', accountSid: '' });
  const [jambonz, setJambonz] = useState({ apiKey: '', accountSid: '', baseUrl: 'https://api.jambonz.cloud', applicationSid: '' });
  const [telephonyEnvActive, setTelephonyEnvActive] = useState(false);

  const [emailProvider, setEmailProvider] = useState('smtp');
  const [smtp, setSmtp] = useState({ host: '', port: '587', user: '', pass: '', fromEmail: '', fromName: '' });
  const [resend, setResend] = useState({ apiKey: '', fromEmail: '', fromName: '' });
  const [sendgrid, setSendgrid] = useState({ apiKey: '', fromEmail: '', fromName: '' });
  const [twilioEmail, setTwilioEmail] = useState({ fromEmail: '', fromName: '' });
  const [smsSender, setSmsSender] = useState('');
  const [testSmsTo, setTestSmsTo] = useState('');
  const [testEmailTo, setTestEmailTo] = useState('');
  const [domains, setDomains] = useState([]);
  const [newDomain, setNewDomain] = useState('');
  const [dnsInfoByDomain, setDnsInfoByDomain] = useState({});
  const [domainMessages, setDomainMessages] = useState({});
  const [identityDrafts, setIdentityDrafts] = useState({});

  const [aiProvider, setAiProvider] = useState('gemini');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [placesKey, setPlacesKey] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [configuredAiProviders, setConfiguredAiProviders] = useState([]);
  const [configuredSettings, setConfiguredSettings] = useState([]);
  const [configuredAiDetails, setConfiguredAiDetails] = useState({});
  const [messages, setMessages] = useState({});
  const [loadError, setLoadError] = useState('');
  // Quando o teste de uma chave falha, guardamos o pedido para oferecer "Salvar mesmo assim".
  const [forceOffer, setForceOffer] = useState(null);
  const prefilled = useRef(false);

  const loadAiProviders = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/ai');
      setConfiguredAiProviders(data.providers || []);
      setConfiguredAiDetails(data.details || {});
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Não foi possível carregar as integrações salvas. Verifique se o backend está rodando.');
    }
  }, []);

  const loadConfiguredSettings = useCallback(async () => {
    try {
      const { data } = await api.get('/settings');
      const list = data.settings || [];
      setConfiguredSettings(list);
      setLoadError('');

      // Na primeira carga, preenche os formulários com o que já está salvo (campos comuns).
      // As chaves secretas nunca voltam inteiras: o formulário mostra só o final (••••abcd).
      if (!prefilled.current) {
        prefilled.current = true;
        const tel = list.find((x) => x.category === 'telephony');
        if (tel?.values?.accountSid) setTelephony((t) => ({ ...t, accountSid: tel.values.accountSid }));

        const aiTel = list.find((x) => x.category === 'ai_telephony');
        if (aiTel && ['twilio', 'telnyx', 'jambonz'].includes(aiTel.provider)) {
          setAiTelProvider(aiTel.provider);
          const v = aiTel.values || {};
          if (aiTel.provider === 'telnyx') setTelnyx((cur) => ({ ...cur, applicationSid: v.applicationSid || '', accountSid: v.accountSid || '' }));
          if (aiTel.provider === 'jambonz') setJambonz((cur) => ({ ...cur, accountSid: v.accountSid || '', baseUrl: v.baseUrl || 'https://api.jambonz.cloud', applicationSid: v.applicationSid || '' }));
        }

        const sms = list.find((x) => x.category === 'sms');
        if (sms?.values?.sender) setSmsSender(sms.values.sender);

        const mail = list.find((x) => x.category === 'email');
        if (mail && ['smtp', 'resend', 'sendgrid', 'native', 'twilio_email'].includes(mail.provider)) {
          setEmailProvider(mail.provider);
          const v = mail.values || {};
          if (mail.provider === 'smtp') {
            setSmtp((cur) => ({ ...cur, host: v.host || '', port: v.port || '587', user: v.user || '', fromEmail: v.fromEmail || '', fromName: v.fromName || '' }));
          }
          if (mail.provider === 'resend') {
            setResend((cur) => ({ ...cur, fromEmail: v.fromEmail || '', fromName: v.fromName || '' }));
          }
          if (mail.provider === 'twilio_email') {
            setTwilioEmail((cur) => ({ ...cur, fromEmail: v.fromEmail || '', fromName: v.fromName || '' }));
          }
          if (mail.provider === 'sendgrid') {
            setSendgrid((cur) => ({ ...cur, fromEmail: v.fromEmail || '', fromName: v.fromName || '' }));
          }
        }
      }
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Não foi possível carregar as integrações salvas. Verifique se o backend está rodando.');
    }
  }, []);

  const loadEnvStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/env-status');
      setTelephonyEnvActive(data.telephonyConfiguredViaEnv);
    } catch (_) {
      /* só informativo */
    }
  }, []);

  const loadDomains = useCallback(async () => {
    const { data } = await api.get('/email-domains');
    setDomains(data.domains);
    setIdentityDrafts((prev) => {
      const next = { ...prev };
      data.domains.forEach((d) => {
        if (!next[d.id]) next[d.id] = { fromEmail: d.fromEmail || '', fromName: d.fromName || '' };
      });
      return next;
    });
  }, []);

  useEffect(() => {
    loadAiProviders();
    loadConfiguredSettings();
    loadEnvStatus();
    loadDomains();
  }, [loadAiProviders, loadConfiguredSettings, loadEnvStatus, loadDomains]);

  // Ao escolher um provedor de IA já configurado, mostra o modelo e o endereço que estavam salvos.
  useEffect(() => {
    const saved = configuredAiDetails[aiProvider];
    setAiModel(saved?.values?.model || '');
    setAiBaseUrl(saved?.values?.baseUrl || '');
  }, [aiProvider, configuredAiDetails]);

  const hintOf = (category, provider, key) =>
    configuredSettings.find((x) => x.category === category && x.provider === provider)?.hints?.[key] || '';

  async function submitSetting({ area, url, body, okText, afterOk }) {
    setForceOffer(null);
    try {
      const { data } = await api.post(url, body);
      setMessages((m) => ({ ...m, [area]: `✅ ${okText}${data?.warning ? ` (aviso: ${data.warning})` : ''}` }));
      if (afterOk) afterOk();
    } catch (error) {
      const d = error.response?.data;
      setMessages((m) => ({ ...m, [area]: `❌ ${d?.error || 'Erro ao salvar'}${d?.details ? ` — ${d.details}` : ''}` }));
      if (d?.canForce) setForceOffer({ area, url, body, okText, afterOk });
    }
  }

  const forceButton = (area) =>
    forceOffer && forceOffer.area === area ? (
      <button
        type="button"
        className="btn-secondary-small"
        onClick={() => submitSetting({ ...forceOffer, body: { ...forceOffer.body, force: true } })}
      >
        Salvar mesmo assim (sem validar)
      </button>
    ) : null;

  async function saveTelephony(e) {
    e.preventDefault();
    setMessages((m) => ({ ...m, telephony: 'Testando as credenciais…' }));
    await submitSetting({
      area: 'telephony',
      url: '/settings/telephony',
      body: { provider: 'twilio', credentials: telephony },
      okText: 'Telefonia configurada e testada com sucesso',
      afterOk: () => {
        setTelephony((t) => ({ ...t, authToken: '' }));
        loadConfiguredSettings();
      }
    });
  }

  async function saveSms(e) {
    e.preventDefault();
    await submitSetting({
      area: 'sms',
      url: '/settings/sms',
      body: { sender: smsSender },
      okText: smsSender ? 'Remetente de SMS salvo' : 'Remetente removido (o sistema usará um número de Linhas)',
      afterOk: loadConfiguredSettings
    });
  }

  async function sendTest(kind) {
    const isSms = kind === 'sms';
    setMessages((m) => ({ ...m, [`${kind}Test`]: 'Enviando teste…' }));
    try {
      const { data } = await api.post(isSms ? '/settings/sms/test' : '/settings/email/test', { to: isSms ? testSmsTo : testEmailTo });
      setMessages((m) => ({ ...m, [`${kind}Test`]: `✅ ${data.message}` }));
    } catch (error) {
      setMessages((m) => ({ ...m, [`${kind}Test`]: `❌ ${error.response?.data?.error || 'Erro ao enviar o teste'}` }));
    }
  }

  async function saveAiTelephony(e) {
    e.preventDefault();
    const credentials = aiTelProvider === 'telnyx' ? telnyx : aiTelProvider === 'jambonz' ? jambonz : {};
    setMessages((m) => ({ ...m, aitel: 'Testando a conexão…' }));
    await submitSetting({
      area: 'aitel',
      url: '/settings/ai-telephony',
      body: { provider: aiTelProvider, credentials },
      okText: aiTelProvider === 'twilio' ? 'As ligações da IA voltaram a usar a Twilio' : 'Operadora da IA configurada — faça uma ligação de teste',
      afterOk: () => {
        setTelnyx((v) => ({ ...v, apiKey: '' }));
        setJambonz((v) => ({ ...v, apiKey: '' }));
        loadConfiguredSettings();
      }
    });
  }

  async function saveEmail(e) {
    e.preventDefault();
    const credentials = emailProvider === 'smtp' ? smtp : emailProvider === 'resend' ? resend : emailProvider === 'sendgrid' ? sendgrid : emailProvider === 'twilio_email' ? twilioEmail : {};
    setMessages((m) => ({ ...m, email: 'Testando a conexão…' }));
    await submitSetting({
      area: 'email',
      url: '/settings/email',
      body: { provider: emailProvider, credentials },
      okText: 'E-mail configurado com sucesso',
      afterOk: () => {
        setSmtp((v) => ({ ...v, pass: '' }));
        setResend((v) => ({ ...v, apiKey: '' }));
        setSendgrid((v) => ({ ...v, apiKey: '' }));
        loadConfiguredSettings();
      }
    });
  }

  const selectedAi = AI_PROVIDERS.find((p) => p.id === aiProvider);

  async function saveAi(e) {
    e.preventDefault();
    setAiSaving(true);
    setMessages((m) => ({ ...m, ai: 'Testando a chave…' }));
    const credentials = { apiKey: aiApiKey, model: aiModel };
    if (selectedAi?.needsBaseUrl) credentials.baseUrl = aiBaseUrl;
    await submitSetting({
      area: 'ai',
      url: '/settings/ai',
      body: { provider: aiProvider, credentials },
      okText: `${aiProviderLabel(aiProvider)} configurado e testado com sucesso`,
      afterOk: () => {
        setAiApiKey('');
        loadAiProviders();
        loadConfiguredSettings();
      }
    });
    setAiSaving(false);
  }

  async function savePlacesKey(e) {
    e.preventDefault();
    if (!placesKey.trim()) {
      setMessages((m) => ({ ...m, places: 'ℹ️ A chave já está salva. Cole uma nova só se quiser trocar.' }));
      return;
    }
    try {
      await api.post('/lead-search/key', { apiKey: placesKey.trim() });
      setMessages((m) => ({ ...m, places: '✅ Chave do Google Maps salva. Já pode usar a Busca de empresas.' }));
      setPlacesKey('');
      loadConfiguredSettings();
    } catch (error) {
      setMessages((m) => ({ ...m, places: `❌ ${error.response?.data?.error || 'Erro'}` }));
    }
  }

  async function addDomain(e) {
    e.preventDefault();
    try {
      await api.post('/email-domains', { domain: newDomain });
      setNewDomain('');
      loadDomains();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao cadastrar domínio');
    }
  }

  async function loadDnsInstructions(domainId) {
    try {
      const { data } = await api.get(`/email-domains/${domainId}/dns-instructions`);
      setDnsInfoByDomain((m) => ({ ...m, [domainId]: data }));
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao buscar instruções de DNS');
    }
  }

  async function verifyDomain(domainId) {
    setDomainMessages((m) => ({ ...m, [domainId]: '⏳ Consultando o DNS público...' }));
    try {
      const { data } = await api.post(`/email-domains/${domainId}/verify`);
      setDomains((list) => list.map((d) => (d.id === domainId ? data.domain : d)));
      const okCount = [data.domain.spfVerified, data.domain.dkimVerified, data.domain.dmarcVerified].filter(Boolean).length;
      setDomainMessages((m) => ({
        ...m,
        [domainId]: okCount === 3 ? '✅ Tudo certo! SPF, DKIM e DMARC verificados.' : `⚠️ ${okCount}/3 registros encontrados até agora — o DNS pode levar algumas horas para propagar.`
      }));
    } catch (error) {
      setDomainMessages((m) => ({ ...m, [domainId]: `❌ ${error.response?.data?.error || 'Erro ao verificar'}` }));
    }
  }

  async function removeDomain(domainId) {
    if (!window.confirm('Remover este domínio? Os disparos por e-mail nativo que usam ele vão parar de funcionar.')) return;
    await api.delete(`/email-domains/${domainId}`);
    loadDomains();
  }

  async function saveIdentity(domainId) {
    try {
      const draft = identityDrafts[domainId] || {};
      await api.patch(`/email-domains/${domainId}/identity`, draft);
      setDomainMessages((m) => ({ ...m, [domainId]: '✅ Remetente salvo.' }));
      loadDomains();
    } catch (error) {
      setDomainMessages((m) => ({ ...m, [domainId]: `❌ ${error.response?.data?.error || 'Erro ao salvar remetente'}` }));
    }
  }

  async function makeDefaultDomain(domainId) {
    try {
      await api.post(`/email-domains/${domainId}/default`);
      loadDomains();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao definir domínio padrão');
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard?.writeText(text);
  }

  async function removeAiProvider(provider) {
    if (!window.confirm(`Remover o provedor de IA "${provider}"?`)) return;
    await api.delete(`/settings/ai/${provider}`);
    loadAiProviders();
    loadConfiguredSettings();
  }

  async function removeConfiguredSetting(category, provider) {
    if (category === 'ai') return removeAiProvider(provider);
    if (!window.confirm(`Remover a integração de ${CATEGORY_LABELS[category] || category} (${provider})?`)) return;
    try {
      await api.delete(`/settings/${category}/${provider}`);
      loadConfiguredSettings();
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao remover integração');
    }
  }

  const telephonyConfiguredInDb = configuredSettings.some((s) => s.category === 'telephony');

  return (
    <div className="config-page">
      <header>
        <h1>Configurações</h1>
        <p>
          O WhatsApp não precisa de configuração aqui — é conexão nativa por QR Code, direto na tela{' '}
          <a href="/conexoes">Conexões</a>.
        </p>
      </header>

      {loadError && <div className="env-banner warning-banner">⚠️ {loadError}</div>}

      {configuredSettings.length > 0 && (
        <div className="card configured-settings-card">
          <h3>✅ Integrações já configuradas</h3>
          <div className="configured-settings-list">
            {configuredSettings.map((s) => (
              <div className="configured-setting-row" key={`${s.category}:${s.provider}`}>
                <div>
                  <strong>{CATEGORY_LABELS[s.category] || s.category}</strong>
                  <span className="secondary-text">
                    {' '}— {s.provider}
                    {Object.values(s.hints || {})[0] ? ` • chave ${Object.values(s.hints)[0]}` : ''}
                    {' '}• atualizado em {new Date(s.updatedAt).toLocaleDateString('pt-BR')}
                  </span>
                  {s.unreadable && (
                    <div className="hint-text">⚠️ Não foi possível ler esta chave (a SETTINGS_ENCRYPTION_KEY do servidor mudou). Cadastre-a de novo.</div>
                  )}
                </div>
                <button className="btn-danger-small" onClick={() => removeConfiguredSetting(s.category, s.provider)}>Remover</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="config-grid">
        <div className="card">
          <h3>📞 Telefonia (Twilio)</h3>
          <p className="card-desc">Usada para o Discador e envio de SMS.</p>

          {telephonyEnvActive && !telephonyConfiguredInDb && (
            <div className="env-banner">
              ✅ Já está funcionando automaticamente, usando as chaves do arquivo <code>.env</code> do servidor.
              Você não precisa preencher nada aqui — o formulário abaixo é só para <strong>substituir</strong> por
              outra credencial diferente, se quiser.
            </div>
          )}

          <form onSubmit={saveTelephony}>
            <input placeholder="Account SID" value={telephony.accountSid} onChange={(e) => setTelephony({ ...telephony, accountSid: e.target.value })} required />
            <input
              placeholder={hintOf('telephony', 'twilio', 'authToken') ? `Auth Token (salvo ${hintOf('telephony', 'twilio', 'authToken')} — deixe vazio para manter)` : 'Auth Token'}
              type="password"
              value={telephony.authToken}
              onChange={(e) => setTelephony({ ...telephony, authToken: e.target.value })}
              required={!hintOf('telephony', 'twilio', 'authToken')}
            />
            <button className="btn-primary" type="submit">Salvar</button>
            {messages.telephony && <p className="config-msg">{messages.telephony}</p>}
            {forceButton('telephony')}
          </form>
          <p className="card-note">
            O número de telefone é cadastrado em Linhas → Números de Discagem — ou, se você preencheu
            <code> TWILIO_CALLER_NUMBER</code> no .env, já foi criado automaticamente lá.
          </p>
        </div>

        <div className="card">
          <h3>💬 SMS (Twilio)</h3>
          <p className="card-desc">
            Os disparos de SMS usam as mesmas chaves da Telefonia (Account SID / Auth Token). Defina abaixo o <strong>remetente</strong>:
            um número da Twilio com SMS (ex.: <code>+12025550123</code>), o ID de um Messaging Service (<code>MG…</code>) ou um nome de
            3 a 11 letras. O número brasileiro usado nas ligações costuma <strong>não</strong> ter SMS — se o disparo parar com
            erro de remetente, use um número com SMS.
          </p>
          <form onSubmit={saveSms}>
            <input placeholder="Remetente do SMS (+1202…, MG… ou nome)" value={smsSender} onChange={(e) => setSmsSender(e.target.value)} />
            <button className="btn-primary" type="submit">Salvar remetente</button>
            {messages.sms && <p className="config-msg">{messages.sms}</p>}
          </form>
          <h4 className="subsection-title">Testar agora</h4>
          <input placeholder="Seu celular com DDD (ex.: 11 99999-8888)" value={testSmsTo} onChange={(e) => setTestSmsTo(e.target.value)} />
          <button type="button" className="btn-secondary-small" onClick={() => sendTest('sms')} disabled={!testSmsTo}>Enviar SMS de teste</button>
          {messages.smsTest && <p className="config-msg">{messages.smsTest}</p>}
          <p className="card-note">Conta Twilio de teste (Trial): só envia para números verificados no console da Twilio. Para o Brasil, ative também Messaging &gt; Settings &gt; Geo permissions &gt; Brazil.</p>
        </div>

        <div className="card">
          <h3>☎️ Telefonia das ligações da IA</h3>
          <p className="card-desc">
            Escolha por onde o <strong>Agente de IA</strong> faz as ligações. O padrão é a Twilio (nada muda se você
            não mexer aqui). O discador manual com vendedor continua sempre na Twilio.
          </p>

          <form onSubmit={saveAiTelephony}>
            <select value={aiTelProvider} onChange={(e) => setAiTelProvider(e.target.value)}>
              <option value="twilio">Twilio (padrão — a mesma configurada acima)</option>
              <option value="telnyx">Telnyx (TeXML) — alternativa mais barata</option>
              <option value="jambonz">Jambonz + tronco SIP (operadora brasileira, minutos ilimitados)</option>
            </select>

            {aiTelProvider === 'twilio' && (
              <p className="hint-text">As ligações da IA usam a Twilio configurada acima. Clique em Salvar para voltar ao padrão, se estava usando outra.</p>
            )}

            {aiTelProvider === 'telnyx' && (
              <>
                <p className="hint-text">
                  (1) Crie conta em telnyx.com e gere uma <strong>API Key v2</strong> (Mission Control → Auth). (2) Crie um
                  <strong> TeXML Application</strong> e, em "Voice Method", use qualquer endereço https (ex.: o do seu servidor) —
                  o sistema informa o endereço correto a cada ligação. (3) Copie o <strong>ID</strong> do TeXML Application.
                  (4) Compre/portabilize um número e cadastre-o em Linhas → Números de Discagem.
                </p>
                <input
                  placeholder={hintOf('ai_telephony', 'telnyx', 'apiKey') ? `API Key da Telnyx (salva ${hintOf('ai_telephony', 'telnyx', 'apiKey')} — deixe vazio para manter)` : 'API Key da Telnyx (KEY...)'}
                  type="password"
                  value={telnyx.apiKey}
                  onChange={(e) => setTelnyx({ ...telnyx, apiKey: e.target.value })}
                  required={!hintOf('ai_telephony', 'telnyx', 'apiKey')}
                />
                <input placeholder="ID do TeXML Application" value={telnyx.applicationSid} onChange={(e) => setTelnyx({ ...telnyx, applicationSid: e.target.value })} required />
                <input placeholder="Account SID (opcional)" value={telnyx.accountSid} onChange={(e) => setTelnyx({ ...telnyx, accountSid: e.target.value })} />
              </>
            )}

            {aiTelProvider === 'jambonz' && (
              <>
                <p className="hint-text">
                  O Jambonz é a ponte entre a IA e o <strong>seu tronco SIP</strong> (Vozio, Voiicr, Avoip, Vivo Empresas...).
                  Use a nuvem jambonz.cloud ou instale no seu servidor. No painel do Jambonz: (1) cadastre o tronco da
                  operadora em <em>Carriers</em>; (2) em <em>Speech</em>, ligue um reconhecimento de voz (Google, Deepgram...) —
                  sem isso a IA não ouve o cliente; (3) gere um <em>API Key</em> e copie o <em>Account SID</em>.
                </p>
                <input
                  placeholder={hintOf('ai_telephony', 'jambonz', 'apiKey') ? `Token da API (salvo ${hintOf('ai_telephony', 'jambonz', 'apiKey')} — deixe vazio para manter)` : 'Token da API do Jambonz'}
                  type="password"
                  value={jambonz.apiKey}
                  onChange={(e) => setJambonz({ ...jambonz, apiKey: e.target.value })}
                  required={!hintOf('ai_telephony', 'jambonz', 'apiKey')}
                />
                <input placeholder="Account SID" value={jambonz.accountSid} onChange={(e) => setJambonz({ ...jambonz, accountSid: e.target.value })} required />
                <input placeholder="Endereço da API (https://api.jambonz.cloud ou o seu servidor)" value={jambonz.baseUrl} onChange={(e) => setJambonz({ ...jambonz, baseUrl: e.target.value })} />
                <input placeholder="Application SID (opcional)" value={jambonz.applicationSid} onChange={(e) => setJambonz({ ...jambonz, applicationSid: e.target.value })} />
              </>
            )}

            <button className="btn-primary" type="submit">Salvar</button>
            {messages.aitel && <p className="config-msg">{messages.aitel}</p>}
            {forceButton('aitel')}
          </form>
          <p className="card-note">
            Atenção: planos "ilimitados" de operadoras costumam proibir discadores em massa (uso aceitável). Confirme com
            a operadora que ligações de IA conversacional são permitidas no seu plano. Faça sempre uma ligação de teste
            depois de trocar de operadora (Ligações → Agente de IA).
          </p>
        </div>

        <div className="card">
          <h3>📧 E-mail</h3>
          <p className="card-desc">
            Vários jeitos de enviar: pelo e-mail da sua empresa (SMTP), pelo Resend ou pela Twilio SendGrid (ambos com plano grátis)
            ou pelo <strong>E-mail Nativo</strong> — motor de envio próprio, sem mensalidade nem limite de terceiros.
          </p>

          <label>Como enviar</label>
          <select value={emailProvider} onChange={(e) => setEmailProvider(e.target.value)}>
            <option value="smtp">📮 E-mail próprio (SMTP)</option>
            <option value="resend">☁️ Resend (plataforma dedicada)</option>
            <option value="twilio_email">✉️ Twilio E-mail (mesmas chaves da Telefonia)</option>
            <option value="sendgrid">📨 Twilio SendGrid (chave SG.)</option>
            <option value="native">🚀 E-mail Nativo (sem terceiros)</option>
          </select>

          <div className="test-row">
            <input placeholder="Seu e-mail para receber um teste" value={testEmailTo} onChange={(e) => setTestEmailTo(e.target.value)} />
            <button type="button" className="btn-secondary-small" onClick={() => sendTest('email')} disabled={!testEmailTo}>Enviar e-mail de teste</button>
            {messages.emailTest && <p className="config-msg">{messages.emailTest}</p>}
          </div>

          {emailProvider === 'smtp' && (
            <form onSubmit={saveEmail}>
              <p className="hint-text">
                Gmail/Google Workspace: host <code>smtp.gmail.com</code>, porta <code>587</code>. Você precisa gerar
                uma <strong>senha de aplicativo</strong> em myaccount.google.com/apppasswords. Outlook/Microsoft 365:
                host <code>smtp.office365.com</code>, porta <code>587</code>.
              </p>
              <input placeholder="Servidor SMTP (ex: smtp.gmail.com)" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} required />
              <input placeholder="Porta (587 ou 465)" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} required />
              <input placeholder="Usuário (seu e-mail completo)" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} required />
              <input
                placeholder={hintOf('email', 'smtp', 'pass') ? `Senha de aplicativo (salva ${hintOf('email', 'smtp', 'pass')} — deixe vazio para manter)` : 'Senha de aplicativo'}
                type="password"
                value={smtp.pass}
                onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })}
                required={!hintOf('email', 'smtp', 'pass')}
              />
              <input placeholder="E-mail remetente (ex: contato@suaempresa.com)" value={smtp.fromEmail} onChange={(e) => setSmtp({ ...smtp, fromEmail: e.target.value })} required />
              <input placeholder="Nome do remetente (ex: Equipe Comercial)" value={smtp.fromName} onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} />
              <button className="btn-primary" type="submit">Salvar</button>
              {messages.email && <p className="config-msg">{messages.email}</p>}
              {forceButton('email')}
            </form>
          )}

          {emailProvider === 'resend' && (
            <form onSubmit={saveEmail}>
              <input
                placeholder={hintOf('email', 'resend', 'apiKey') ? `API Key do Resend (salva ${hintOf('email', 'resend', 'apiKey')} — deixe vazio para manter)` : 'API Key do Resend'}
                type="password"
                value={resend.apiKey}
                onChange={(e) => setResend({ ...resend, apiKey: e.target.value })}
                required={!hintOf('email', 'resend', 'apiKey')}
              />
              <input placeholder="E-mail remetente" value={resend.fromEmail} onChange={(e) => setResend({ ...resend, fromEmail: e.target.value })} required />
              <input placeholder="Nome do remetente" value={resend.fromName} onChange={(e) => setResend({ ...resend, fromName: e.target.value })} />
              <button className="btn-primary" type="submit">Salvar</button>
              {messages.email && <p className="config-msg">{messages.email}</p>}
              {forceButton('email')}
            </form>
          )}

          {emailProvider === 'twilio_email' && (
            <form onSubmit={saveEmail}>
              <p className="hint-text">
                É o "Try out Email" do console da Twilio. Usa o <strong>Account SID e o Auth Token</strong> já salvos em
                Telefonia (não precisa de chave SG.). O e-mail remetente precisa estar <strong>verificado/autenticado na
                Twilio</strong> (Console → Email → Senders ou Domain Authentication). Esse envio não aceita anexos.
              </p>
              <input placeholder="E-mail remetente verificado na Twilio" value={twilioEmail.fromEmail} onChange={(e) => setTwilioEmail({ ...twilioEmail, fromEmail: e.target.value })} required />
              <input placeholder="Nome do remetente" value={twilioEmail.fromName} onChange={(e) => setTwilioEmail({ ...twilioEmail, fromName: e.target.value })} />
              <button className="btn-primary" type="submit">Salvar</button>
              {messages.email && <p className="config-msg">{messages.email}</p>}
              {forceButton('email')}
            </form>
          )}

          {emailProvider === 'sendgrid' && (
            <form onSubmit={saveEmail}>
              <p className="hint-text">
                O e-mail da Twilio é o <strong>SendGrid</strong> e usa uma chave própria — <strong>não</strong> é o Account
                SID/Auth Token. Passo a passo: (1) entre em app.sendgrid.com (pelo console da Twilio, em "Send an email");
                (2) em <em>Settings → API Keys</em> crie uma chave com permissão <em>Mail Send</em> (ou Full Access) e copie
                o valor que começa com <code>SG.</code>; (3) em <em>Settings → Sender Authentication</em> verifique o
                e-mail remetente (Single Sender) ou o domínio. O e-mail remetente abaixo precisa ser exatamente o verificado.
              </p>
              <input
                placeholder={hintOf('email', 'sendgrid', 'apiKey') ? `API Key do SendGrid (salva ${hintOf('email', 'sendgrid', 'apiKey')} — deixe vazio para manter)` : 'API Key do SendGrid (SG.xxxxx)'}
                type="password"
                value={sendgrid.apiKey}
                onChange={(e) => setSendgrid({ ...sendgrid, apiKey: e.target.value })}
                required={!hintOf('email', 'sendgrid', 'apiKey')}
              />
              <input placeholder="E-mail remetente verificado no SendGrid" value={sendgrid.fromEmail} onChange={(e) => setSendgrid({ ...sendgrid, fromEmail: e.target.value })} required />
              <input placeholder="Nome do remetente" value={sendgrid.fromName} onChange={(e) => setSendgrid({ ...sendgrid, fromName: e.target.value })} />
              <button className="btn-primary" type="submit">Salvar</button>
              {messages.email && <p className="config-msg">{messages.email}</p>}
              {forceButton('email')}
            </form>
          )}

          {emailProvider === 'native' && (
            <>
              <div className="env-banner warning-banner">
                ⚠️ Antes de usar: entregabilidade (o e-mail não cair em spam) depende de coisas que nenhum código
                resolve sozinho — a porta 25 de saída liberada no servidor, um IP não bloqueado e um registro de
                DNS reverso (PTR) configurado no seu provedor de hospedagem. Configure os registros de DNS abaixo
                e comece enviando poucos e-mails por dia, aumentando aos poucos.
              </div>

              <h4 className="subsection-title">1) Domínios e remetentes</h4>
              <p className="hint-text">
                Cada domínio verificado pode ter seu próprio nome/e-mail de remetente — útil se você representa mais
                de uma empresa ou marca. Qualquer endereço "@dominio" funciona sem configuração técnica extra; só
                precisa de um domínio novo (com seus próprios registros de DNS) quando o nome depois do @ muda.
              </p>

              {domains.length > 0 && (
                <div className="domain-list">
                  {domains.map((d) => (
                    <div className="domain-row" key={d.id}>
                      <div className="domain-row-header">
                        <strong>{d.domain}</strong>
                        <span className="badge-group">
                          {d.isDefault && <span className="badge badge-default">Padrão</span>}
                          <span className={`badge ${d.spfVerified && d.dkimVerified ? 'badge-ok' : 'badge-pending'}`}>
                            {d.spfVerified && d.dkimVerified ? 'DNS verificado' : 'DNS pendente'}
                          </span>
                        </span>
                      </div>

                      <div className="identity-fields">
                        <input
                          placeholder={`E-mail remetente (ex: contato@${d.domain})`}
                          value={identityDrafts[d.id]?.fromEmail ?? ''}
                          onChange={(e) => setIdentityDrafts((prev) => ({ ...prev, [d.id]: { ...prev[d.id], fromEmail: e.target.value } }))}
                        />
                        <input
                          placeholder="Nome do remetente (ex: Equipe Comercial)"
                          value={identityDrafts[d.id]?.fromName ?? ''}
                          onChange={(e) => setIdentityDrafts((prev) => ({ ...prev, [d.id]: { ...prev[d.id], fromName: e.target.value } }))}
                        />
                        <button type="button" className="btn-secondary-small" onClick={() => saveIdentity(d.id)}>Salvar remetente</button>
                      </div>

                      <div className="domain-row-actions">
                        {!d.isDefault && (
                          <button type="button" className="btn-secondary-small" onClick={() => makeDefaultDomain(d.id)}>Tornar padrão</button>
                        )}
                        <button type="button" className="btn-secondary-small" onClick={() => loadDnsInstructions(d.id)}>Ver registros de DNS</button>
                        <button type="button" className="btn-secondary-small" onClick={() => verifyDomain(d.id)}>Verificar DNS agora</button>
                        <button type="button" className="btn-danger-small" onClick={() => removeDomain(d.id)}>Remover</button>
                      </div>
                      {domainMessages[d.id] && <p className="config-msg">{domainMessages[d.id]}</p>}

                      {dnsInfoByDomain[d.id] && (
                        <table className="dns-table">
                          <thead>
                            <tr><th>Tipo</th><th>Host</th><th>Valor</th><th /></tr>
                          </thead>
                          <tbody>
                            {dnsInfoByDomain[d.id].records.map((r) => (
                              <tr key={r.host}>
                                <td>{r.type}</td>
                                <td><code>{r.host}</code></td>
                                <td className="dns-value-cell"><code>{r.value}</code></td>
                                <td>
                                  <button type="button" className="btn-secondary-small" onClick={() => copyToClipboard(r.value)}>Copiar</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={addDomain} className="inline-form">
                <input placeholder="Novo domínio (ex: suaempresa.com.br)" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} required />
                <button className="btn-secondary" type="submit">Cadastrar domínio</button>
              </form>

              <h4 className="subsection-title">2) Ativar o E-mail Nativo</h4>
              {domains.length === 0 ? (
                <p className="hint-text">Cadastre pelo menos um domínio acima antes de ativar.</p>
              ) : (
                <form onSubmit={saveEmail}>
                  <p className="hint-text">
                    Isto só liga o motor de envio nativo como provedor ativo da conta — o remetente usado em cada
                    disparo é o domínio marcado como "Padrão" acima (ou o que você escolher na hora de criar o disparo).
                  </p>
                  <button className="btn-primary" type="submit">Ativar E-mail Nativo</button>
                  {messages.email && <p className="config-msg">{messages.email}</p>}
              {forceButton('email')}
                </form>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h3>🤖 Inteligência Artificial</h3>
          <p className="card-desc">Configure quantos provedores quiser. Cada campanha escolhe qual usar.</p>

          {configuredAiProviders.length > 0 && (
            <ul className="ai-provider-list">
              {configuredAiProviders.map((p) => (
                <li key={p}>
                  <span>✅ {aiProviderLabel(p)}</span>
                  <button type="button" className="btn-danger-small" onClick={() => removeAiProvider(p)}>Remover</button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={saveAi}>
            <label>Provedor</label>
            <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
              {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {selectedAi?.hint && <p className="card-desc">{selectedAi.hint}</p>}
            {selectedAi?.needsBaseUrl && (
              <input placeholder="Endereço da API (ex: https://meu-servidor.com/v1)" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} required />
            )}
            <input
              placeholder={configuredAiDetails[aiProvider]?.hints?.apiKey ? `API Key (salva ${configuredAiDetails[aiProvider].hints.apiKey} — deixe vazio para manter)` : 'API Key'}
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              required={!configuredAiDetails[aiProvider]?.hints?.apiKey}
            />
            <input
              placeholder={selectedAi?.model ? `Modelo (opcional — padrão: ${selectedAi.model})` : 'Nome do modelo'}
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              required={Boolean(selectedAi?.needsBaseUrl)}
            />
            <button className="btn-primary" type="submit" disabled={aiSaving}>{aiSaving ? 'Testando…' : 'Salvar e testar'}</button>
            {messages.ai && <p className="config-msg">{messages.ai}</p>}
            {forceButton('ai')}
          </form>
        </div>

        <div className="card">
          <h3>🔍 Busca de empresas (Google Maps)</h3>
          <p className="card-desc">
            Para buscar empresas pelo Google Maps, cadastre a sua chave da <strong>Places API (New)</strong> no Google Cloud (console.cloud.google.com → APIs e serviços → ative "Places API (New)" → Credenciais → Criar chave de API).
            O Google dá um crédito mensal gratuito; o uso acima disso é cobrado por ele no seu cartão. Sem a chave, a busca usa o OpenStreetMap (gratuito, com menos telefones).
          </p>
          <form onSubmit={savePlacesKey}>
            <input
              placeholder={hintOf('leadsearch', 'google_places', 'apiKey') ? `Chave de API do Google (salva ${hintOf('leadsearch', 'google_places', 'apiKey')} — cole outra só para trocar)` : 'Chave de API do Google'}
              type="password"
              value={placesKey}
              onChange={(e) => setPlacesKey(e.target.value)}
              required={!hintOf('leadsearch', 'google_places', 'apiKey')}
              minLength={20}
            />
            <button className="btn-primary" type="submit">Salvar chave</button>
            {messages.places && <p className="config-msg">{messages.places}</p>}
          </form>
        </div>
      </div>
    </div>
  );
}