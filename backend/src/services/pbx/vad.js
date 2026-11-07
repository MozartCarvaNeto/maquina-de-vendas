// backend/src/services/pbx/vad.js
// Detector de fala por energia (sem dependências). Recebe quadros de 20 ms (320 bytes, 16 bits 8 kHz) e
// avisa quando a pessoa começou e quando terminou de falar.
const FRAME_MS = 20;

function rms(frame) {
  const n = Math.floor(frame.length / 2);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const v = frame.readInt16LE(i * 2);
    s += v * v;
  }
  return Math.sqrt(s / n);
}

class Vad {
  constructor({ startFrames = 6, endSilenceMs = 900, minVoice = 450, maxUtteranceMs = 20000, preRollMs = 300 } = {}) {
    this.startFrames = startFrames;
    this.endFrames = Math.round(endSilenceMs / FRAME_MS);
    this.minVoice = minVoice;
    this.maxFrames = Math.round(maxUtteranceMs / FRAME_MS);
    this.preRollFrames = Math.round(preRollMs / FRAME_MS);
    this.noise = 120; // piso de ruído aprendido
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.voiced = 0;
    this.silent = 0;
    this.pre = [];
    this.chunks = [];
    this.frames = 0;
  }

  threshold() {
    return Math.max(this.minVoice, this.noise * 3);
  }

  /** @returns {{event:'start'|'end'|null, audio?:Buffer}} */
  push(frame) {
    const e = rms(frame);
    const loud = e > this.threshold();
    if (!this.speaking) {
      if (!loud) this.noise = this.noise * 0.95 + e * 0.05;
      this.pre.push(frame);
      if (this.pre.length > this.preRollFrames + this.startFrames) this.pre.shift();
      this.voiced = loud ? this.voiced + 1 : 0;
      if (this.voiced >= this.startFrames) {
        this.speaking = true;
        this.chunks = [...this.pre];
        this.frames = this.chunks.length;
        this.silent = 0;
        return { event: 'start' };
      }
      return { event: null };
    }
    this.chunks.push(frame);
    this.frames += 1;
    this.silent = loud ? 0 : this.silent + 1;
    if (this.silent >= this.endFrames || this.frames >= this.maxFrames) {
      const audio = Buffer.concat(this.chunks);
      this.reset();
      return { event: 'end', audio };
    }
    return { event: null };
  }
}

module.exports = { Vad, rms, FRAME_MS };
