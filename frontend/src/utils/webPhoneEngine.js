// frontend/src/utils/webPhoneEngine.js
//
// Motor de áudio do "telefone no navegador" (WebRTC). Não depende de React nem do servidor:
// só cria a proposta/resposta de conexão (SDP), liga o microfone e toca o áudio de quem está do outro lado.
// A API de chamadas do WhatsApp (Meta) exige:
//   - só áudio, codec Opus (+ telephone-event para teclas);
//   - SDP COMPLETO, já com os candidatos de rede (sem "trickle ICE") — por isso esperamos o fim da coleta.
const ICE_GATHER_TIMEOUT_MS = 5000;

export function isWebPhoneSupported() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';
}

function waitForIceComplete(pc, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    const onCandidate = (ev) => { if (!ev.candidate) done(); };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/** Só Opus (e telephone-event): é o que o WhatsApp aceita. */
function restrictToOpus(transceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities('audio');
    if (!caps || !transceiver.setCodecPreferences) return;
    const wanted = caps.codecs.filter((c) => /audio\/(opus|telephone-event)/i.test(c.mimeType));
    if (wanted.length) transceiver.setCodecPreferences(wanted);
  } catch {
    /* navegador sem suporte: segue com o padrão */
  }
}

export function describeMicError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço do site e permita o microfone. (O sistema precisa estar em https.)';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Nenhum microfone foi encontrado neste aparelho.';
  if (name === 'NotReadableError') return 'O microfone está sendo usado por outro programa. Feche-o e tente de novo.';
  return error?.message || 'Não foi possível acessar o microfone.';
}

export class WebPhoneEngine {
  /**
   * @param {{iceServers?: RTCIceServer[], onState?: (state:string)=>void, onRemoteStream?: (s:MediaStream)=>void}} opts
   * state: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
   */
  constructor({ iceServers = [], onState, onRemoteStream } = {}) {
    this.iceServers = iceServers;
    this.onState = onState || (() => {});
    this.onRemoteStream = onRemoteStream || (() => {});
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.muted = false;
  }

  async _open() {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc.addEventListener('connectionstatechange', () => this.onState(this.pc?.connectionState || 'closed'));
    this.pc.addEventListener('track', (ev) => {
      this.remoteStream = ev.streams[0] || new MediaStream([ev.track]);
      this.onRemoteStream(this.remoteStream);
    });
  }

  /** Ligação FEITA por nós: devolve o SDP offer completo. */
  async createOffer() {
    await this._open();
    const track = this.localStream.getAudioTracks()[0];
    const transceiver = this.pc.addTransceiver(track, { direction: 'sendrecv', streams: [this.localStream] });
    restrictToOpus(transceiver);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIceComplete(this.pc);
    return this.pc.localDescription.sdp;
  }

  /** Resposta da outra ponta à nossa proposta. */
  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** Ligação RECEBIDA: aplica o SDP offer da Meta e devolve o SDP answer completo. */
  async answerOffer(offerSdp) {
    await this._open();
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const track = this.localStream.getAudioTracks()[0];
    const transceiver = this.pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'audio') || this.pc.getTransceivers()[0];
    if (transceiver) {
      await transceiver.sender.replaceTrack(track);
      transceiver.direction = 'sendrecv';
      restrictToOpus(transceiver);
    } else {
      this.pc.addTrack(track, this.localStream);
    }
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIceComplete(this.pc);
    return this.pc.localDescription.sdp;
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
  }

  /** Bytes de áudio recebidos/enviados até agora (para o teste e para detectar "chamada muda"). */
  async audioStats() {
    const out = { bytesReceived: 0, bytesSent: 0 };
    if (!this.pc) return out;
    const report = await this.pc.getStats();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.bytesReceived += r.bytesReceived || 0;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.bytesSent += r.bytesSent || 0;
    });
    return out;
  }

  close() {
    try { this.localStream?.getTracks().forEach((t) => t.stop()); } catch { /* já parado */ }
    try { this.pc?.close(); } catch { /* já fechado */ }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.onState('closed');
  }
}

/**
 * Autoteste: liga duas pontas dentro da própria página (como se fossem você e a Meta) e confere se
 * o áudio realmente flui. Valida microfone, WebRTC, Opus e SDP completo — sem precisar de conta na Meta.
 */
export async function runLoopbackTest(iceServers = []) {
  const result = { ok: false, steps: [], error: null };
  const step = (name, ok, detail = '') => result.steps.push({ name, ok, detail });
  const a = new WebPhoneEngine({ iceServers });
  const b = new WebPhoneEngine({ iceServers });
  try {
    const offer = await a.createOffer();
    step('Microfone liberado e proposta criada', true);
    const hasOpus = /opus\/48000/i.test(offer);
    const audioOnly = !/m=video/i.test(offer);
    step('Proposta só de áudio com Opus', hasOpus && audioOnly, hasOpus && audioOnly ? '' : 'a proposta não está no formato que o WhatsApp exige');
    const hasCandidates = /a=candidate:/i.test(offer);
    step('Proposta já traz os caminhos de rede (ICE completo)', hasCandidates, hasCandidates ? '' : 'sem candidatos de rede — a rede pode estar bloqueando WebRTC');

    const answer = await b.answerOffer(offer);
    step('Resposta criada', /a=setup:active/i.test(answer), /a=setup:active/i.test(answer) ? '' : 'a resposta deveria ter a=setup:active');
    await a.acceptAnswer(answer);

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(a.pc.connectionState === 'connected' && b.pc.connectionState === 'connected')) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const connected = a.pc.connectionState === 'connected' && b.pc.connectionState === 'connected';
    step('Conexão de áudio estabelecida', connected, connected ? '' : `estado: ${a.pc.connectionState}/${b.pc.connectionState}`);

    if (connected) {
      await new Promise((r) => setTimeout(r, 2000));
      const stats = await b.audioStats();
      step('Áudio chegando do outro lado', stats.bytesReceived > 0, `${stats.bytesReceived} bytes recebidos`);
    }
    result.ok = result.steps.every((s) => s.ok);
  } catch (error) {
    result.error = describeMicError(error);
    step('Teste', false, result.error);
  } finally {
    a.close();
    b.close();
  }
  return result;
}
