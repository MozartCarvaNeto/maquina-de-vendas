// frontend/src/components/phone/PhoneProvider.jsx
//
// "Telefone no navegador" para chamadas de WhatsApp (API Oficial da Meta). Fica montado no App inteiro:
// o aviso de chamada recebida aparece em qualquer tela. O áudio vai direto do navegador para a Meta (WebRTC);
// o servidor só troca as propostas de conexão (SDP) e acompanha o estado.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';
import { useSocket } from '../../hooks/useSocket';
import { WebPhoneEngine, describeMicError, isWebPhoneSupported } from '../../utils/webPhoneEngine';
import './Phone.css';

const PhoneContext = createContext({ startCall: () => {}, supported: false, busy: false });
export const usePhone = () => useContext(PhoneContext);

const RING_TIMEOUT_MS = 60000;

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Toque simples feito pelo navegador (sem arquivo de som). */
function useRingtone(active) {
  useEffect(() => {
    if (!active) return undefined;
    let ctx;
    let timer;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      };
      beep();
      timer = setInterval(beep, 2000);
    } catch { /* sem áudio de toque: só o aviso visual */ }
    return () => {
      clearInterval(timer);
      try { ctx?.close(); } catch { /* ok */ }
    };
  }, [active]);
}

export default function PhoneProvider({ children }) {
  useLocation(); // refaz a leitura do login quando a pessoa entra/sai (sem precisar recarregar a página)
  const currentUser = JSON.parse(localStorage.getItem('mdv_user') || '{}');
  const { socket } = useSocket(currentUser.accountId);

  // call: { callId, direction: 'saida'|'entrada', name, phone, leadId, connectionId, status, sdpOffer, message }
  // status: preparando | chamando | tocando | conectando | em_andamento | encerrada | erro
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const engineRef = useRef(null);
  const callRef = useRef(null);
  const audioRef = useRef(null);
  const ringTimerRef = useRef(null);
  const clearTimerRef = useRef(null);

  callRef.current = call;
  const supported = isWebPhoneSupported();
  const busy = !!call && !['encerrada', 'erro'].includes(call.status);

  useRingtone(call?.direction === 'entrada' && call?.status === 'tocando');

  const cleanup = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    engineRef.current?.close();
    engineRef.current = null;
    setMuted(false);
  }, []);

  const finish = useCallback((status, message) => {
    cleanup();
    setCall((c) => (c ? { ...c, status, message } : c));
    clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => setCall(null), status === 'erro' ? 9000 : 4000);
  }, [cleanup]);

  useEffect(() => () => { cleanup(); clearTimeout(clearTimerRef.current); }, [cleanup]);

  // Cronômetro da chamada em andamento.
  useEffect(() => {
    if (call?.status !== 'em_andamento') { setSeconds(0); return undefined; }
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [call?.status]);

  const buildEngine = useCallback(async () => {
    const { data } = await api.get('/whatsapp-calls/config');
    return new WebPhoneEngine({
      iceServers: data.iceServers,
      onRemoteStream: (stream) => { if (audioRef.current) { audioRef.current.srcObject = stream; audioRef.current.play?.().catch(() => null); } },
      onState: (state) => {
        if (state === 'connected') setCall((c) => (c && c.status !== 'encerrada' ? { ...c, status: 'em_andamento' } : c));
        if (state === 'failed') finish('erro', 'A conexão de áudio falhou (rede bloqueando a ligação). Tente de novo ou use outra rede.');
      }
    });
  }, [finish]);

  // ---------------- ligar
  const startCall = useCallback(async ({ lead, connectionId }) => {
    if (busy) return;
    if (!supported) { alert('Este navegador não suporta chamadas. Use o Chrome, Edge ou Safari atualizado, em https.'); return; }
    setCall({ direction: 'saida', name: lead.name || lead.phone, phone: lead.phone, leadId: lead.id, connectionId, status: 'preparando' });
    try {
      engineRef.current = await buildEngine();
      const sdp = await engineRef.current.createOffer();
      const { data } = await api.post('/whatsapp-calls/outgoing', { connectionId, leadId: lead.id, sdp });
      setCall((c) => ({ ...c, callId: data.callId, status: 'chamando' }));
      ringTimerRef.current = setTimeout(() => hangUp('Ninguém atendeu.'), RING_TIMEOUT_MS);
    } catch (error) {
      const message = error.response?.data?.error || describeMicError(error);
      const needsPermission = /autorizou|permissão/i.test(message);
      cleanup();
      setCall((c) => ({ ...c, status: 'erro', message, needsPermission }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, supported, buildEngine, cleanup]);

  // ---------------- atender / recusar / desligar
  async function acceptIncoming() {
    const current = callRef.current;
    if (!current?.sdpOffer) return;
    setCall((c) => ({ ...c, status: 'conectando' }));
    try {
      engineRef.current = await buildEngine();
      const sdp = await engineRef.current.answerOffer(current.sdpOffer);
      await api.post(`/whatsapp-calls/${current.callId}/accept`, { sdp });
    } catch (error) {
      cleanup();
      finish('erro', error.response?.data?.error || describeMicError(error));
    }
  }

  async function rejectIncoming() {
    const current = callRef.current;
    cleanup();
    setCall(null);
    if (current?.callId) await api.post(`/whatsapp-calls/${current.callId}/reject`).catch(() => null);
  }

  async function hangUp(note) {
    const current = callRef.current;
    if (!current) return;
    if (current.callId) await api.post(`/whatsapp-calls/${current.callId}/terminate`).catch(() => null);
    finish('encerrada', typeof note === 'string' ? note : 'Chamada encerrada.');
  }

  async function askPermission() {
    const current = callRef.current;
    try {
      await api.post('/whatsapp-calls/permission', { connectionId: current.connectionId, leadId: current.leadId });
      setCall((c) => ({ ...c, message: '✅ Pedido enviado. Quando o contato aceitar no WhatsApp, você poderá ligar.', needsPermission: false }));
    } catch (error) {
      setCall((c) => ({ ...c, message: error.response?.data?.error || 'Não foi possível enviar o pedido.' }));
    }
  }

  // ---------------- eventos do servidor (webhook da Meta -> socket)
  useEffect(() => {
    if (!socket) return undefined;

    const onIncoming = (data) => {
      if (callRef.current && !['encerrada', 'erro'].includes(callRef.current.status)) {
        api.post(`/whatsapp-calls/${data.callId}/reject`).catch(() => null); // já em outra chamada: ocupado
        return;
      }
      clearTimeout(clearTimerRef.current);
      setCall({ ...data, direction: 'entrada', status: 'tocando' });
    };
    const onAnswer = async ({ callId, sdpAnswer }) => {
      if (callRef.current?.callId !== callId || !engineRef.current) return;
      try {
        clearTimeout(ringTimerRef.current);
        await engineRef.current.acceptAnswer(sdpAnswer);
        setCall((c) => ({ ...c, status: 'conectando' }));
      } catch (error) {
        finish('erro', 'Não consegui conectar o áudio da chamada.');
      }
    };
    const onStatus = ({ callId, status }) => {
      if (callRef.current?.callId !== callId) return;
      if (status === 'REJECTED') finish('encerrada', 'O contato recusou a chamada.');
    };
    const onEnded = ({ callId, duration, error }) => {
      if (callRef.current?.callId !== callId) return;
      finish('encerrada', error || (duration ? `Chamada encerrada (${formatClock(duration)}).` : 'Chamada encerrada.'));
    };
    const onPermission = ({ granted }) => {
      if (granted) setCall((c) => (c ? { ...c, message: '✅ O contato autorizou ligações. Pode ligar agora.' } : c));
    };

    socket.on('whatsapp:call:incoming', onIncoming);
    socket.on('whatsapp:call:answer', onAnswer);
    socket.on('whatsapp:call:status', onStatus);
    socket.on('whatsapp:call:ended', onEnded);
    socket.on('whatsapp:call:permission', onPermission);
    return () => {
      socket.off('whatsapp:call:incoming', onIncoming);
      socket.off('whatsapp:call:answer', onAnswer);
      socket.off('whatsapp:call:status', onStatus);
      socket.off('whatsapp:call:ended', onEnded);
      socket.off('whatsapp:call:permission', onPermission);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    engineRef.current?.setMuted(next);
  }

  const value = useMemo(() => ({ startCall, supported, busy }), [startCall, supported, busy]);

  const LABEL = {
    preparando: 'Preparando o microfone…',
    chamando: 'Chamando…',
    tocando: 'Chamada de WhatsApp',
    conectando: 'Conectando o áudio…',
    em_andamento: formatClock(seconds),
    encerrada: call?.message || 'Chamada encerrada.',
    erro: call?.message || 'Não foi possível completar a chamada.'
  };

  return (
    <PhoneContext.Provider value={value}>
      {children}
      <audio ref={audioRef} autoPlay playsInline />
      {call && (
        <div className={`phone-card ${call.status} ${call.direction}`} role="dialog" aria-label="Chamada de WhatsApp">
          <div className="phone-head">{call.direction === 'entrada' ? '📞 Chamada recebida' : '📞 Chamada de WhatsApp'}</div>
          <div className="phone-body">
            <strong>{call.name}</strong>
            <span>{call.phone}</span>
            <p className={`phone-status ${call.status}`}>{LABEL[call.status]}</p>
            {call.status === 'erro' && call.message && call.message !== LABEL.erro && <p className="phone-note">{call.message}</p>}
            {call.message && call.status !== 'erro' && call.status !== 'encerrada' && <p className="phone-note">{call.message}</p>}
          </div>
          <div className="phone-actions">
            {call.status === 'tocando' && (
              <>
                <button type="button" className="phone-btn accept" onClick={acceptIncoming}>Atender</button>
                <button type="button" className="phone-btn reject" onClick={rejectIncoming}>Recusar</button>
              </>
            )}
            {['preparando', 'chamando', 'conectando', 'em_andamento'].includes(call.status) && (
              <>
                {call.status === 'em_andamento' && (
                  <button type="button" className={`phone-btn ${muted ? 'muted' : ''}`} onClick={toggleMute}>{muted ? '🔇 Mudo' : '🎤 Microfone'}</button>
                )}
                <button type="button" className="phone-btn reject" onClick={() => hangUp()}>Desligar</button>
              </>
            )}
            {call.status === 'erro' && call.needsPermission && (
              <button type="button" className="phone-btn accept" onClick={askPermission}>Pedir permissão ao contato</button>
            )}
            {['erro', 'encerrada'].includes(call.status) && (
              <button type="button" className="phone-btn" onClick={() => setCall(null)}>Fechar</button>
            )}
          </div>
        </div>
      )}
    </PhoneContext.Provider>
  );
}
