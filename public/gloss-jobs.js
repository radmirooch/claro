import { state } from './state.js';
import { $ } from './dom.js';
import { compatibleSource, validateGlosses, validateInterlinear } from './annotations.js';
import { readJSONLines } from './stream.js';
import { post } from './translation-jobs.js';
import { showTranslation, renderHistory } from './render-history.js';

export function glossEnabled(event) {
  return $('translationLayout').value === 'words' &&
    $('showOriginal').value !== 'hide' &&
    $('translationMode').value !== 'off' &&
    ($('translationMode').value !== 'tap' || event.revealed) &&
    ($('readingMode').value === 'live' || event.final !== false) &&
    state.config?.gloss?.ready &&
    !event.demo &&
    event.source_language !== event.target_language
  ;
}

export function cancelGlosses() {
  state.glossEpoch++;
  for (const job of state.glossQueue.items)
    job.event.gloss_status = 'cancelled';
  state.glossQueue.clear();
  if (state.activeGloss) {
    state.activeGloss.event.gloss_status = 'cancelled';
    state.activeGloss.controller.abort();
  }
}

export function requestGloss(event, translated = null, force = false) {
  if (!event || !glossEnabled(event) || !event.translation)
    return;
  // A hint always refers to the exact text used for its translation, never to
  // a later ASR revision which happens to share the caption ID.
  const text = translated?.text || event.translated_text;
  if (!text || !compatibleSource(event.text, text))
    return;
  const final = translated ? translated.final : event.final !== false && text === event.text;
  if (!force && event.gloss_text === text && ['ready', 'empty'].includes(event.gloss_status))
    return;
  if (state.activeGloss?.event === event && state.activeGloss.text === text && state.activeGloss.epoch === state.glossEpoch)
    return;
  if (state.glossQueue.items.some(job => job.event === event && job.text === text))
    return;
  const job = {
    id: event.id,
    event,
    text,
    translation: translated?.translation || event.translation,
    source: event.source_language,
    target: event.target_language,
    revision: translated?.revision || event.translation_revision || 1,
    final,
    epoch: state.glossEpoch
  };
  const dropped = state.glossQueue.push(job);
  if (dropped)
    dropped.event.gloss_status = 'overflow';
  if (dropped !== job)
    event.gloss_status = 'pending';
  drainGlosses();
}

export async function glossJob(job, onPartial) {
  const payload = JSON.stringify({
    caption_id: job.id,
    text: job.text,
    translation: job.translation,
    source_language: job.source,
    target_language: job.target
  });
  if (!state.config?.features?.gloss_streaming)
    return post('/api/gloss', payload, 'application/json', job.controller.signal);
  const response = await fetch('/api/gloss-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': state.config.token },
    body: payload,
    signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(180000)])
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  let result;
  await readJSONLines(response.body, event => {
    if (event.error)
      throw new Error(event.error);
    if (event.caption_id !== job.id)
      throw new Error('Подсказки относятся к другой фразе.');
    if (event.final)
      result = event;
    else
      onPartial(event.glosses);
  });
  if (!result)
    throw new Error('Подсказки не завершены.');
  return result;
}

export async function drainGlosses() {
  if (state.glossing)
    return;
  state.glossing = true;
  try {
    while (state.glossQueue.length) {
      // Avoid starting optional word work while recognition or phrase translation is queued.
      if (
        $('readingMode').value !== 'live' &&
        (state.processing || state.queue.length || state.translating || state.translationQueue.length)
      )
        break;
      // Completed phrases take priority; queued drafts are coalesced by ID.
      const finalIndex = state.glossQueue.items.findIndex(job => job.final);
      const job = finalIndex < 0 ? state.glossQueue.shift() : state.glossQueue.items.splice(finalIndex, 1)[0];
      const valid = () =>
        job.epoch === state.glossEpoch &&
        state.messages.get(job.id) === job.event &&
        glossEnabled(job.event) &&
        job.event.source_language === job.source &&
        job.event.target_language === job.target &&
        compatibleSource(job.event.text, job.text);
      if (!valid())
        continue;
      job.controller = new AbortController();
      state.activeGloss = job;
      showTranslation();
      try {
        const result = await glossJob(job, glosses => {
          if (!valid())
            return;
          job.event.glosses = validateGlosses(job.event.text, glosses);
          job.event.gloss_text = job.text;
          job.event.gloss_status = 'pending';
          showTranslation();
        });
        if (!valid())
          continue;
        job.event.glosses = validateInterlinear(job.text, result.glosses, true);
        job.event.gloss_text = job.text;
        job.event.gloss_status = job.event.text === job.text ? 'ready' : 'pending';
        state.moduleBus.publish('interlinear', {
          caption_id: job.id,
          text: job.text,
          glosses: job.event.glosses
        });
      } catch {
        if (valid())
          job.event.gloss_status = 'error';
      } finally {
        state.activeGloss = null;
      }
      showTranslation();
      if (!$('historyPanel').hidden)
        renderHistory();
    }
  } finally {
    state.glossing = false;
    showTranslation();
  }
}

export function queueExistingGlosses() {
  // Switching layouts should not enqueue an entire long conversation.
  for (const event of [...state.messages.values()].slice(-8))
    requestGloss(event);
}
