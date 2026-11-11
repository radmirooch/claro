// Keep the whole utterance for context; only the display cadence is short.
export class LiveBuffer {
  constructor(rate, interval = 1.5, threshold = .012, maxSeconds = 12, pauseSeconds = 1.2) {
    this.rate = rate;
    this.interval = interval;
    this.threshold = threshold;
    this.maxSeconds = maxSeconds;
    this.pauseSeconds = pauseSeconds;
    this.sequence = 0;
    this.clock = 0;
    this.reset();
  }
  reset() {
    this.frames = [];
    this.preroll = [];
    this.length = 0;
    this.voice = 0;
    this.silence = 0;
    this.lastEmit = 0;
    this.revision = 0;
  }
  snapshot(final, endReason = null) {
    const audio = new Float32Array(this.length);
    let offset = 0;
    for (const frame of this.frames) {
      audio.set(frame, offset);
      offset += frame.length;
    }
    this.lastEmit = this.length;
    return {
      audio,
      sequence: this.sequence,
      revision: ++this.revision,
      final,
      start_seconds: (this.clock - this.length) / this.rate,
      speech_end_seconds: (this.clock - this.silence) / this.rate,
      end_reason: endReason
    };
  }
  flush() {
    const update = this.voice >= this.rate * .18 ? this.snapshot(true, 'stop') : null;
    this.reset();
    return update;
  }
  push(frame) {
    this.clock += frame.length;
    const rms = Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / frame.length);
    if (!this.frames.length && rms < this.threshold) {
      this.preroll.push(frame);
      while (this.preroll.reduce((n, f) => n + f.length, 0) > this.rate * .2)
        this.preroll.shift();
      return { rms };
    }
    if (!this.frames.length) {
      this.sequence++;
      this.frames = this.preroll;
      this.preroll = [];
      this.length = this.frames.reduce((n, f) => n + f.length, 0);
    }
    this.frames.push(frame);
    this.length += frame.length;
    if (rms >= this.threshold) {
      this.voice += frame.length;
      this.silence = 0;
    } else
      this.silence += frame.length;
    // Breaths should not finish the sentence. Near the audio limit, prefer a
    // meaningful pause; the hard cap still bounds model context and payload size.
    const pause = this.silence >= this.rate * this.pauseSeconds;
    const nearLimit =
      this.length >= this.rate * (this.maxSeconds - 1) && this.silence >= this.rate * .45;
    const limit = this.length >= this.rate * this.maxSeconds;
    const final = pause || nearLimit || limit;
    let update;
    if (
      this.voice >= this.rate * .18 &&
      (final ||
        (this.silence < this.rate * .3 &&
          this.length - this.lastEmit >= this.rate * this.interval))
    )
      update = this.snapshot(final, final ? limit ? 'limit' : 'pause' : null);
    if (final)
      this.reset();
    return { rms, update };
  }
}

// This is conservative presentation grouping, not a language-model rewrite.
// Audio segments and translations retain their own IDs and original wording.
export function hasSentenceEnding(text) {
  const stripped = text
    .trim()
    .replace(/[.!?…。！？»”"')\]]+$/u, '')
    .trim();
  const connector =
    /(?:^|\s)(?:и|но|или|потому|что|чтобы|если|когда|для|на|в|к|с|без|бы|y|pero|porque|que|si|cuando|para|de|del|con|sin|and|but|because|if|when|to|with|without)$/iu.test(
      stripped
    );
  return !connector && /[.!?…。！？][»”"')\]]*$/u.test(text.trim());
}

export function readingBlocks(events) {
  const groups = [];
  for (const event of events) {
    const group = groups.at(-1),
      previous = group?.at(-1);
    const gap = event.start_seconds - previous?.speech_end_seconds;
    const continuation =
      previous &&
      event.capture_session &&
      previous.capture_session === event.capture_session &&
      previous.source_language === event.source_language &&
      previous.target_language === event.target_language &&
      (previous.speaker_id ?? null) === (event.speaker_id ?? null) &&
      previous.final &&
      previous.end_reason !== 'stop' &&
      gap >= -.25 &&
      gap <= 3 &&
      !hasSentenceEnding(previous.text) &&
      group.reduce((size, item) => size + item.text.length, 0) + event.text.length < 500 &&
      group.length < 4;
    if (continuation)
      group.push(event);
    else
      groups.push([event]);
  }
  return groups.map(parts => {
    if (parts.length === 1)
      return { ...parts[0], parts };
    const last = parts.at(-1),
      translations = parts.map(part => part.translation || '…');
    const state = parts.every(part => part.translation_status === 'ready')
      ? 'ready'
      : [
          'error',
          'overflow',
          'cancelled',
          'unavailable',
          'on_demand',
          'off',
          'streaming',
          'translating',
          'pending'
        ].find(status => parts.some(part => part.translation_status === status)) || 'provisional';
    return {
      ...parts[0],
      parts,
      text: parts.map(part => part.text).join(' '),
      translation: parts.some(part => part.translation) ? translations.join(' ') : null,
      final: last.final,
      translation_status: state,
      glosses: parts.flatMap(part => part.glosses || []),
      revealed: parts.every(part => part.revealed),
      gloss_status: parts.some(part => part.gloss_status === 'pending')
        ? 'pending'
        : last.gloss_status
    };
  });
}

// Superseded partials do not become an audio backlog. Finals replace partials.
export class CaptionQueue {
  constructor(limit = 3) {
    this.items = [];
    this.limit = limit;
  }
  get length() {
    return this.items.length;
  }
  clear() {
    this.items = [];
  }
  shift() {
    return this.items.shift();
  }
  push(job) {
    const index = this.items.findIndex(item => item.id === job.id);
    if (index !== -1) {
      if (this.items[index].revision < job.revision)
        this.items[index] = job;
      return null;
    }
    this.items.push(job);
    if (this.items.length <= this.limit)
      return null;
    const partial = this.items.findIndex(item => !item.final);
    return this.items.splice(partial === -1 ? 0 : partial, 1)[0];
  }
}

export class LatestQueue {
  constructor() {
    this.items = [];
  }
  get length() {
    return this.items.length;
  }
  clear() {
    const old = this.items;
    this.items = [];
    return old;
  }
  push(job) {
    const old = this.items[0];
    this.items = [job];
    return old;
  }
  shift() {
    return this.items.shift();
  }
}

// A conversation needs every translation, not just the latest one. Keep a
// bounded FIFO; report overflow to the caller so that the message can be retried.
export class TranslationQueue {
  constructor(limit = 50) {
    this.items = [];
    this.limit = limit;
  }
  get length() {
    return this.items.length;
  }
  clear() {
    const old = this.items;
    this.items = [];
    return old;
  }
  push(job) {
    if (this.items.some(item => item.event.id === job.event.id))
      return null;
    if (this.items.length >= this.limit)
      return job;
    this.items.push(job);
    return null;
  }
  shift() {
    return this.items.shift();
  }
}
