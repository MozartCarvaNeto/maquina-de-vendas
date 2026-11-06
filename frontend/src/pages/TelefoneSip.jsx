// frontend/src/pages/TelefoneSip.jsx
import { useEffect, useState } from 'react';
import api from '../services/api';
import { useSipPhone } from '../components/phone/SipPhoneProvider';
import './TelefoneSip.css';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const REG_LABEL = { offline: '⚪ Desconectado', connecting: '🟡 Conectando…', registered: '🟢 Pronto para ligar e receber', error: '🔴 Sem conexão' };
const STATUS = { answered: 'Atendida', missed: 'Perdida', rejected: 'Recusada', failed: 'Falhou', canceled: 'Cancelada', busy: 'Ocupado' };
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function TelefoneSip() {
  const phone = useSipPhone();
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const call = phone.call;
  const busy = call && call.state !== 'ended';

  useEffect(() => {
    api.get('/voice/calls').then(({ data }) => setHistory(data)).catch(() => {});
  }, [phone.historyVersion]);

  function press(k) {
    if (busy && call.state === 'connected') phone.dtmf(k);
    else setNumber((n) => n + k);
  }
  function startCall() {
    const r = phone.dial(number);
    setError(r.error || '');
  }

  if (!phone.enabled) {
    return (
      <div className="sipphone-page">
        <h1>📞 Telefone</h1>
        <p className="hint-text">
          {phone.reason || 'O telefone SIP não está disponível: o módulo "Gateway de telecom" precisa estar no plano e o servidor de telefonia (Asterisk) configurado. Veja o guia da atualização.'}
        </p>
      </div>
    );
  }

  return (
    <div className="sipphone-page">
      <h1>📞 Telefone</h1>
      <p className="sip-reg">{REG_LABEL[phone.regState] || phone.regState}{phone.regDetail && phone.regState !== 'registered' ? ` — ${phone.regDetail}` : ''}</p>
      <div className="sip-dial">
        {busy ? (
          <div className="sip-live">
            <strong>{phone.contactName || call.displayName || call.number}</strong>
            <span>{call.number}</span>
            <p>{call.state === 'incoming' ? 'Tocando…' : call.state === 'calling' ? 'Chamando…' : call.state === 'ringing' ? 'Tocando do outro lado…' : clock(phone.seconds)}</p>
          </div>
        ) : (
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="DDD + número" inputMode="tel" onKeyDown={(e) => e.key === 'Enter' && startCall()} />
        )}
        <div className="sip-pad">{KEYS.map((k) => <button key={k} type="button" onClick={() => press(k)}>{k}</button>)}</div>
        <div className="sip-controls">
          {!busy && <><button type="button" className="sip-call" onClick={startCall} disabled={phone.regState !== 'registered'}>📞 Ligar</button><button type="button" onClick={() => setNumber((n) => n.slice(0, -1))}>⌫</button></>}
          {busy && call.state === 'incoming' && <><button type="button" className="sip-call" onClick={phone.answer}>Atender</button><button type="button" className="sip-hang" onClick={phone.reject}>Recusar</button></>}
          {busy && call.state !== 'incoming' && <><button type="button" onClick={() => phone.mute(!call.muted)}>{call.muted ? '🔇 Ativar som' : '🎤 Mudo'}</button><button type="button" className="sip-hang" onClick={phone.hangup}>Desligar</button></>}
        </div>
        {(error || (call && call.state === 'ended' && call.endReason)) && <p className="sip-error">{error || call.endReason}</p>}
      </div>

      <h3>Últimas chamadas</h3>
      <table className="sip-history">
        <thead><tr><th>Quando</th><th></th><th>Número</th><th>Situação</th><th>Duração</th></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{new Date(h.startedAt).toLocaleString('pt-BR')}</td>
              <td>{h.direction === 'in' ? '⬅️' : '➡️'}</td>
              <td>{h.contactName ? `${h.contactName} · ` : ''}{h.number}</td>
              <td>{STATUS[h.status] || h.status}</td>
              <td>{h.durationSec ? clock(h.durationSec) : '—'}</td>
            </tr>
          ))}
          {history.length === 0 && <tr><td colSpan={5}>Nenhuma chamada ainda.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
