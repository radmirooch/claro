export function validateWav(b) {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Нужен WAV PCM, mono, 16 kHz, 16 bit.');
  let fmt = false, samples = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const type = b.toString('ascii', i, i + 4), size = b.readUInt32LE(i + 4), start = i + 8;
    if (start + size > b.length) throw new Error('Неполный WAV.');
    if (type === 'fmt ') {
      if (size < 16 || b.readUInt16LE(start) !== 1 || b.readUInt16LE(start + 2) !== 1 || b.readUInt32LE(start + 4) !== 16000 || b.readUInt16LE(start + 14) !== 16) throw new Error('Нужен WAV PCM, mono, 16 kHz, 16 bit.');
      fmt = true;
    }
    if (type === 'data') { if (size % 2) throw new Error('Неполный PCM.'); samples += size / 2; }
    i = start + size + (size % 2);
  }
  if (!fmt || samples < 1600 || samples > 16000 * 15) throw new Error('Допустимая длина фрагмента: 0,1–15 секунд.');
  return samples / 16000;
}

export class WhisperAdapter {
  constructor(url) { this.url = url; }
  async transcribe(wav, language) {
    const form = new FormData();
    form.set('file', new Blob([wav], {type: 'audio/wav'}), 'speech.wav');
    form.set('response_format', 'json');
    form.set('language', language);
    form.set('translate', 'false');
    form.set('temperature', '0');
    const response = await fetch(`${this.url}/inference`, {method: 'POST', body: form, signal: AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(`Whisper: HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result.text !== 'string') throw new Error('Whisper вернул неожиданный ответ.');
    return result.text.trim();
  }
}

