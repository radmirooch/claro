import { state } from './state.js';
import { $ } from './dom.js';
import { readJSONLines } from './stream.js';
import { showTranslation, renderHistory } from './render-history.js';
import { cancelGlosses, requestGloss, drainGlosses } from './gloss-jobs.js';

export async function post(path, body, type = 'audio/wav', signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Session-Token': state.config.token },
    body,
    signal: signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(path.startsWith('/api/gloss') ? 180000 : 70000)
        ])
      : AbortSignal.timeout(70000)
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

export function cancelTranslations() {
  cancelGlosses();
  state.translationEpoch++;
  for (const { event } of state.translationQueue.items)
    if (['pending', 'translating', 'streaming'].includes(event.translation_status))
      event.translation_status = 'cancelled';
  if (
    state.activeTranslation &&
    ['pending', 'translating', 'streaming'].includes(state.activeTranslation.event.translation_status)
  )
    state.activeTranslation.event.translation_status = 'cancelled';
  state.activeTranslation?.controller?.abort();
  state.translationQueue.clear();
  state.pendingPartial = null;
  state.partialSubmitted.clear();
}

export function requestTranslation(event, force = false) {
  const partial = event.final === false;
  if (
    partial &&
    ($('readingMode').value !== 'live' ||
      !state.config?.features?.live_translation ||
      $('translationMode').value !== 'always')
  )
    return;
  if (event.source_language === event.target_language) {
    event.translation = null;
    event.translation_status = 'same_language';
    showTranslation();
    return;
  }
  if ($('translationMode').value === 'off') {
    event.translation_status = 'off';
    showTranslation();
    return;
  }
  if ($('translationMode').value === 'tap' && !force) {
    event.translation_status = 'on_demand';
    showTranslation();
    return;
  }
  if (!state.config?.translator) {
    event.translation_status = 'unavailable';
    showTranslation();
    return;
  }
  const job = {
    event,
    epoch: state.translationEpoch,
    target: event.target_language,
    source: event.source_language,
    text: event.text,
    revision: event.revision || 1,
    final: !partial
  };
  if (partial) {
    if (event.text.trim().length < 8)
      return;
    const last = state.partialSubmitted.get(event.id);
    // At most one pending draft; refresh roughly every two seconds of audio.
    if (last && (event.text === last.text || event.audio_seconds - last.audio < 1.5))
      return;
    state.partialSubmitted.set(event.id, { text: event.text, audio: event.audio_seconds });
    state.pendingPartial = job;
    if (!event.translation)
      event.translation_status = 'pending';
  } else {
    if (state.pendingPartial?.event.id === event.id)
      state.pendingPartial = null;
    state.partialSubmitted.delete(event.id);
    if (
      state.translationQueue.items.some(item => item.event.id === event.id) ||
      (state.activeTranslation?.final && state.activeTranslation.event.id === event.id)
    )
      return;
    if (force)
      event.revealed = true;
    event.translation_status = 'pending';
    const rejected = state.translationQueue.push(job);
    if (rejected)
      rejected.event.translation_status = 'overflow';
  }
  showTranslation();
  drainTranslations();
}

export async function translateJob(job, onPartial) {
  const payload = JSON.stringify({
    caption_id: job.event.id,
    text: job.text,
    source_language: job.source,
    target_language: job.target
  });
  if (!state.config?.features?.translation_streaming)
    return post('/api/translate', payload, 'application/json', job.controller.signal);
  const response = await fetch('/api/translate-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': state.config.token },
    body: payload,
    signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(70000)])
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  // Same-language responses and older providers can return a complete JSON result.
  if (!response.headers.get('content-type')?.includes('application/x-ndjson'))
    return response.json();
  let result;
  await readJSONLines(response.body, event => {
    if (event.error)
      throw new Error(event.error);
    if (event.caption_id !== job.event.id)
      throw new Error('Перевод относится к другой фразе.');
    if (event.final)
      result = event;
    else
      onPartial(event);
  });
  if (!result)
    throw new Error('Перевод не завершён.');
  return result;
}

export async function drainTranslations() {
  if (state.translating)
    return;
  state.translating = true;
  try {
    while (state.translationQueue.length || state.pendingPartial) {
      let job = state.translationQueue.shift();
      if (!job) {
        job = state.pendingPartial;
        state.pendingPartial = null;
      }
      if (job.epoch !== state.translationEpoch || state.messages.get(job.event.id) !== job.event)
        continue;
      job.controller = new AbortController();
      state.activeTranslation = job;
      job.event.translation_status = 'translating';
      showTranslation();
      const valid = () =>
        job.epoch === state.translationEpoch &&
        state.messages.get(job.event.id) === job.event &&
        job.event.target_language === job.target;
      let lastPaint = -Infinity;
      try {
        const result = await translateJob(job, partial => {
          if (!valid())
            return;
          job.event.translation = partial.translation;
          job.event.translation_status = job.final ? 'streaming' : 'provisional';
          job.event.translation_revision = job.revision;
          if (performance.now() - lastPaint > 60) {
            showTranslation();
            lastPaint = performance.now();
          }
        });
        if (!valid())
          continue;
        job.event.translation = result.translation;
        job.event.translation_status = job.final ? 'ready' : 'provisional';
        job.event.translation_revision = job.revision;
        job.event.translation_ms = result.processing_ms;
        state.lastTranslated = job.event;
        job.event.translated_text = job.text;
        state.moduleBus.publish('translation', {
          caption_id: job.event.id,
          revision: job.revision,
          text: job.text,
          translation: result.translation
        });
        requestGloss(job.event, { ...job, translation: result.translation });
      } catch {
        if (valid())
          job.event.translation_status = 'error';
      } finally {
        state.activeTranslation = null;
      }
      showTranslation();
      if (!$('historyPanel').hidden)
        renderHistory();
    }
  } finally {
    state.translating = false;
    showTranslation();
    drainGlosses();
  }
}
