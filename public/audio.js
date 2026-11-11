// Browser/native clients share a simple wire format: WAV PCM16 mono @ 16 kHz.
export function encodeWav(samples, sourceRate) {
  const length = Math.floor(samples.length * 16000 / sourceRate);
  const buffer = new ArrayBuffer(44 + length * 2), view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * sourceRate / 16000), end = Math.max(start + 1, Math.floor((i + 1) * sourceRate / 16000));
    let sum = 0; for (let j = start; j < Math.min(end, samples.length); j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return buffer;
}

// Energy gate, not a learned VAD. Short preroll protects initial consonants.
export class PhraseBuffer {
  constructor(rate, seconds = 4, threshold = 0.012) {this.rate = rate; this.seconds = seconds; this.threshold = threshold; this.reset();}
  reset() {this.frames = []; this.preroll = []; this.length = 0; this.silence = 0; this.voice = 0;}
  push(frame) {
    const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
    if (rms >= this.threshold) {
      if (!this.frames.length) {this.frames = this.preroll; this.length = this.frames.reduce((s, f) => s + f.length, 0); this.preroll = [];}
      this.voice += frame.length; this.silence = 0;
    } else this.silence += frame.length;
    if (!this.frames.length && rms < this.threshold) {
      this.preroll.push(frame); while (this.preroll.reduce((s, f) => s + f.length, 0) > this.rate * 0.2) this.preroll.shift(); return {rms};
    }
    this.frames.push(frame); this.length += frame.length;
    if (this.length < this.rate * this.seconds && this.silence < this.rate * 0.55) return {rms};
    let audio;
    if (this.voice >= this.rate * 0.18) {audio = new Float32Array(this.length); let offset = 0; for (const f of this.frames) {audio.set(f, offset); offset += f.length;}}
    this.reset(); return {rms, audio};
  }
}
