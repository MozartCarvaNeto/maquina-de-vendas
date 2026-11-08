// frontend/src/components/phone/SipPhoneProvider.jsx
//
// Telefone SIP do navegador (ligações comuns pelo Asterisk do próprio servidor). Fica montado no App inteiro:
// o aviso de chamada recebida aparece em qualquer tela enquanto o sistema estiver aberto.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';
import { SipClient } from '../../utils/sipClient';
import { WebPhoneEngine, describeMicError, isWebPhoneSupported } from '../../utils/webPhoneEngine';
import { getStoredUser, userHasFeature } from '../../utils/features';
import './SipPhone.css';

const SipContext = createContext({ enabled: false, regState: 'offline', call: null, dial: () => {}, answer: () => {}, hangup: () => {}, reject: () => {} });
export const useSipPhone = () => useContext(SipContext);

const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Número digitado -> formato internacional brasileiro que o Asterisk espera (ex.: 5511999998888). */
export function normalizeDialNumber(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d; // ramal interno ou número internacional já completo
}

function useRingtone(active) {
  useEffect(() => {
    if (!active) return undefined;
    let ctx; let timer;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.frequency.value = 480; gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.6);
      };
      beep(); timer = setInterval(beep, 2000);
    } catch { /* só o aviso visual */ }
    return () => { clearInterval(timer); try { ctx?.close(); } catch { /* ok */ } };
  }, [active]);
}

export default function SipPhoneProvider({ children }) {
  const location = useLocation();
  const [config, setConfig] = useState(null); // credenciais do ramal
  const [disabledReason, setDisabledReason] = useState('');
  const [regState, setRegState] = useState('offline');
  const [regDetail, setRegDetail] = useState('');
  const [call, setCall] = useState(null);
  const [tick, setTick] = useState(0);
  const [contactName, setContactName] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const clientRef = useRef(null);
  const audioRef = useRef(null);
  const loggedRef = useRef(new Set());

  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('mdv_token') : null;
  const user = getStoredUser();
  const allowed = Boolean(token) && userHasFeature(user, 'gateway') && isWebPhoneSupported();

  // 1) pega as credenciais do ramal (1x por login)
  useEffect(() => {
    if (!allowed || config || disabledReason) return;
    api.get('/voice/me')
      .then(({ data }) => { if (data.wssUrl) setConfig(data); else setDisabledReason('Endereço do servidor de telefonia não configurado.'); })
      .catch((e) => setDisabledReason(e.response?.status === 403 || e.response?.status === 404 ? '' : (e.response?.data?.error || e.message)));
  }, [allowed, config, disabledReason, location.pathname]);

  const finalize = useCallback((c, name) => {
    if (loggedRef.current.has(c.callId)) return;
    loggedRef.current.add(c.callId);
    const status = c.finalStatus === 'answered' && !c.answeredAt ? 'failed' : c.finalStatus;
    api.post('/voice/calls', {
      direction: c.direction, number: c.number, contactName: name || c.displayName || null, status: status || 'failed',
      startedAt: new Date(c.startedAt).toISOString(), answeredAt: c.answeredAt ? new Date(c.answeredAt).toISOString() : null,
      endedAt: new Date(c.endedAt || Date.now()).toISOString()
    }).then(() => setHistoryVersion((v) => v + 1)).catch(() => {});
  }, []);

  const watch = useCallback((c) => {
    setCall(c);
    setContactName(null);
    api.get('/voice/lookup', { params: { number: c.number } }).then(({ data }) => { if (data.name) { setContactName(data.name); c.contactName = data.name; } }).catch(() => {});
    c.onChange((x) => {
      setCall({ ...Object.assign(Object.create(Object.getPrototypeOf(x)), x) });
      if (x.state === 'ended') {
        finalize(x, x.contactName);
        setTimeout(() => setCall((cur) => (cur && cur.callId === x.callId ? null : cur)), 3500);
      }
      if (x.remoteStream && audioRef.current && audioRef.current.srcObject !== x.remoteStream) {
        audioRef.current.srcObject = x.remoteStream;
        audioRef.current.play().catch(() => {});
      }
    });
  }, [finalize]);

  // 2) liga o cliente SIP
  useEffect(() => {
    if (!config) return undefined;
    const client = new SipClient({
      wssUrl: config.wssUrl,
      domain: config.domain,
      extension: config.extension,
      password: config.password,
      displayName: config.displayName,
      engineFactory: (cb) => new WebPhoneEngine({ iceServers: config.iceServers, opusOnly: false, ...cb }),
      onRegState: (s, d) => { setRegState(s); setRegDetail(d || ''); },
      onIncoming: (c) => {
        if (clientRef.current && [...clientRef.current.calls.values()].some((o) => o !== c && !o.ended)) { c.reject(); return; } // já em ligação: ocupado
        watch(c);
        try { if (Notification.permission === 'granted') new Notification('📞 Ligação recebida', { body: c.number }); } catch { /* sem notificação */ }
      }
    });
    clientRef.current = client;
    client.start();
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ok */ }
    return () => { client.stop(); clientRef.current = null; };
  }, [config, watch]);

  // cronômetro
  useEffect(() => {
    if (!call || call.state !== 'connected') return undefined;
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [call?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  useRingtone(Boolean(call && call.direction === 'in' && call.state === 'incoming'));

  const dial = useCallback((raw) => {
    const number = normalizeDialNumber(raw);
    if (!number) return { error: 'Digite o número com DDD.' };
    if (!clientRef.current || regState !== 'registered') return { error: 'O telefone ainda não está conectado ao servidor.' };
    if (call && !call.ended) return { error: 'Já existe uma ligação em andamento.' };
    try { watch(clientRef.current.call(number)); return {}; } catch (e) { return { error: describeMicError(e) }; }
  }, [call, regState, watch]);

  const raw = call && clientRef.current ? clientRef.current.calls.get(call.callId) : null;
  const api2 = useMemo(() => ({
    enabled: Boolean(config),
    reason: disabledReason,
    regState,
    regDetail,
    call,
    contactName,
    historyVersion,
    seconds: call && call.answeredAt && call.state === 'connected' ? Math.max(0, Math.round((Date.now() - call.answeredAt) / 1000)) : 0,
    dial,
    answer: () => raw && raw.answer(),
    reject: () => raw && raw.reject(),
    hangup: () => raw && raw.hangup(),
    mute: (m) => raw && raw.setMuted(m),
    dtmf: (t) => raw && raw.sendDtmf(t),
    transfer: (t) => raw && raw.transfer(t)
  }), [config, disabledReason, regState, regDetail, call, contactName, historyVersion, dial, raw, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = call && call.state !== 'ended' ? call : null;
  const onPhonePage = location.pathname.startsWith('/telefone-sip');

  return (
    <SipContext.Provider value={api2}>
      {children}
      <audio ref={audioRef} autoPlay playsInline />
      {call && !onPhonePage && (
        <div className={`sip-card ${call.state === 'incoming' ? 'tocando' : ''}`}>
          <div className="sip-head">{call.direction === 'in' ? '📞 Ligação recebida' : '📞 Ligando'}</div>
          <div className="sip-body">
            <strong>{contactName || call.displayName || call.number}</strong>
            {(contactName || call.displayName) && <span>{call.number}</span>}
            <p className={`sip-status ${call.state}`}>
              {call.state === 'incoming' && 'Tocando…'}
              {call.state === 'calling' && 'Chamando…'}
              {call.state === 'ringing' && 'Tocando do outro lado…'}
              {call.state === 'connected' && clock(api2.seconds)}
              {call.state === 'ended' && (call.endReason || 'Encerrada')}
            </p>
          </div>
          <div className="sip-actions">
            {call.state === 'incoming' && <><button type="button" className="sip-btn ok" onClick={api2.answer}>Atender</button><button type="button" className="sip-btn bad" onClick={api2.reject}>Recusar</button></>}
            {call.state !== 'incoming' && active && <><button type="button" className="sip-btn" onClick={() => api2.mute(!call.muted)}>{call.muted ? '🔇 Ativar som' : '🎤 Mudo'}</button>{call.state === 'connected' && <button type="button" className="sip-btn" onClick={() => { const t = window.prompt('Transferir para qual ramal ou número?'); if (t) api2.transfer(t); }}>↪️ Transferir</button>}<button type="button" className="sip-btn bad" onClick={api2.hangup}>Desligar</button></>}
          </div>
          {call.transferError && <p className="sip-status">{call.transferError}</p>}
        </div>
      )}
    </SipContext.Provider>
  );
}
