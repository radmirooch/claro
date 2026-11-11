import { encodeWav } from './audio.js';
import { LiveBuffer, CaptionQueue, TranslationQueue, readingBlocks } from './live.js';
import { LANGUAGES, languageByCode } from './languages.js';
import { renderAnnotated, validateGlosses, validateInterlinear, sourceUnits, compatibleSource } from './annotations.js';
import { splitFinalCaption, draftTail } from './reading.js';
import { readJSONLines } from './stream.js';
import { defaultParticipants, readParticipants, assignSpeaker, SPEAKER_COLORS } from './participants.js';
import { createModuleBus } from './modules.js';
const moduleBus = createModuleBus();
let participants = defaultParticipants();
try {
  participants = readParticipants(JSON.parse(localStorage.getItem('claro.participants.v1')));
} catch {}
const $ = id => document.getElementById(id);
const preferenceIds = [
  'language',
  'targetLanguage',
  'engine',
  'interval',
  'threshold',
  'translationMode',
  'translationLayout',
  'sentencePause',
  'showOriginal',
  'showParticipants',
  'textSize',
  'readingMode'
];
for (const id of ['language', 'targetLanguage']) {
  for (const lang of LANGUAGES) {
    const option = new Option(lang.label, lang.code);
    $(id).add(option);
  }
}
$('language').value = 'es';
$('targetLanguage').value = 'ru';
try {
  const prefs = JSON.parse(localStorage.getItem('claro.preferences.v1') || '{}');
  for (const id of preferenceIds)
    if ([...$(id).options].some(o => o.value === prefs[id]))
      $(id).value = prefs[id];
} catch {}
function savePreferences() {
  try {
    localStorage.setItem(
      'claro.preferences.v1',
      JSON.stringify(Object.fromEntries(preferenceIds.map(id => [id, $(id).value])))
    );
  } catch {}
}
let config,
  running = false,
  starting = false,
  generation = 0,
  translationEpoch = 0,
  stream,
  context,
  source,
  capture,
  silent;
const queue = new CaptionQueue(),
  translationQueue = new TranslationQueue(),
  glossQueue = new CaptionQueue(8);
let processing = false,
  translating = false,
  activeTranslation,
  lastTranslated,
  engineInitialized = false;
let history = [],
  current,
  demoActive = false,
  liveReady = false,
  glossing = false;
let flushCapture,
  transcriptEpoch = 0,
  followConversation = true,
  pendingPartial = null;
const partialSubmitted = new Map();
let glossEpoch = 0,
  activeGloss,
  wordPeek = null;
const messages = new Map(),
  messageRows = new Map();
const translationMessage = 'Переводчик пока не готов. Оригинал остаётся доступен.';
function status(text) {
  $('status').textContent = text;
}
function setLanguage(element, code) {
  element.lang = code || '';
  element.dir = languageByCode(code)?.dir || 'auto';
}
function showTranslation() {
  renderConversation();
  refreshWordPeek();
}
function refreshWordPeek() {
  if (!wordPeek)
    return;
  const event = messages.get(wordPeek.id);
  if (!event || event.text !== wordPeek.text) {
    wordPeek = null;
    $('wordDialog').close();
    return;
  }
  const unit = sourceUnits(event.text)[wordPeek.index],
    meaning = validateGlosses(event.text, event.glosses).find(
      span => span.start <= unit.start && span.end >= unit.end
    )?.meaning;
  $('wordMeaning').textContent =
    meaning ||
    (['error', 'overflow', 'unavailable'].includes(event.gloss_status) || !config?.gloss?.ready
      ? 'Перевод слова недоступен. Можно повторить перевод сообщения.'
      : 'Перевод слова ещё готовится…');
}
function peekWord(event, index) {
  wordPeek = { id: event.id, text: event.text, index };
  $('wordOriginal').textContent = sourceUnits(event.text)[index].source;
  refreshWordPeek();
  $('wordDialog').showModal();
  if (!event.translation)
    requestTranslation(event);
  else if (event.gloss_status !== 'ready')
    requestGloss(event, null, ['error', 'overflow', 'cancelled'].includes(event.gloss_status));
}
function revealMessage(event) {
  const open = !event.parts.every(part => part.revealed);
  for (const part of event.parts) {
    part.revealed = open;
    if (open) {
      if (
        !part.translation ||
        ['error', 'overflow', 'cancelled', 'unavailable'].includes(part.translation_status)
      )
        requestTranslation(part, true);
      else
        requestGloss(part);
    }
  }
  showTranslation();
}
function acceptFinal(event) {
  const chunks = splitFinalCaption(event);
  if (chunks.length > 1) {
    messages.delete(event.id);
    history = history.filter(item => item.id !== event.id);
  }
  for (const chunk of chunks) {
    show(chunk);
    requestTranslation(chunk);
  }
}
function readingAnchor(feed) {
  const bounds = feed.getBoundingClientRect?.();
  if (!bounds)
    return null;
  for (const [id, row] of messageRows) {
    const nodes = row.querySelectorAll?.('.message-original,.message-translation') || [];
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      if (box.bottom > bounds.top && box.top < bounds.bottom)
        return {
          id,
          selector: node.classList.contains('message-original')
            ? '.message-original'
            : '.message-translation',
          offset: box.top - bounds.top
        };
    }
  }
  return null;
}
function restoreReadingAnchor(feed, anchor) {
  const node = anchor && messageRows.get(anchor.id)?.querySelector?.(anchor.selector);
  if (node)
    feed.scrollTop +=
      node.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset;
}
function messengerBlocks(events) {
  // A finalized phrase keeps one identity regardless of viewport or translation.
  return events.map(event => ({ ...event, parts: [event], sourceOffset: 0 }));
}
function renderConversation() {
  const mode = $('translationMode').value,
    words = $('translationLayout').value === 'words';
  const feed = $('messageFeed'),
    list = $('messageList');
  const anchor = followConversation ? null : readingAnchor(feed);
  document.body.setAttribute('data-text-size', $('textSize').value || 'normal');
  const steady = $('readingMode').value !== 'live';
  const all = [...messages.values()],
    draft = steady ? all.filter(event => event.final === false).at(-1) : null;
  $('draftPanel').hidden = !draft || ($('showOriginal').value === 'hide' && mode !== 'off');
  $('draftText').textContent = draft ? draftTail(draft.text) : '';
  const blocks = messengerBlocks(
      all.filter(event => !steady || event.final !== false),
      words && mode !== 'off'
    ),
    blockIds = new Set(blocks.map(block => block.id));
  $('emptyState').hidden = all.length > 0;
  for (const [id, row] of messageRows)
    if (!blockIds.has(id)) {
      row.remove();
      messageRows.delete(id);
    }
  for (const event of blocks) {
    let row = messageRows.get(event.id);
    if (!row) {
      row = document.createElement('article');
      row.className = 'message';
      row.setAttribute('data-caption-id', event.id);
      messageRows.set(event.id, row);
      list.append(row);
    } else
      list.appendChild?.(row); // Keep continuation bubbles in source order after resize.
    const visible = mode !== 'off' && (!['tap', 'peek'].includes(mode) || event.revealed);
    const concealed = ['peek', 'tap'].includes(mode) && !visible;
    const signature = JSON.stringify([
      event,
      mode,
      words,
      $('showOriginal').value,
      $('showParticipants').value,
      participants,
      config?.translator,
      config?.gloss?.ready
    ]);
    if (row.signature === signature)
      continue;
    row.signature = signature;
    row.replaceChildren();
    row.classList.toggle('partial', event.final === false);
    row.classList.toggle('translation-concealed', concealed);
    row.onclick =
      mode === 'peek'
        ? e => {
            if (e.target?.closest?.('button,select,input,a'))
              return;
            revealMessage(event);
          }
        : null;
    row.onkeydown =
      mode === 'peek'
        ? e => {
            if (e.target === row && ['Enter', ' '].includes(e.key)) {
              e.preventDefault();
              revealMessage(event);
            }
          }
        : null;
    row.tabIndex = mode === 'peek' ? 0 : -1;
    if (mode === 'peek') {
      row.setAttribute(
        'aria-label',
        'Сообщение. Нажми, чтобы ' + (visible ? 'скрыть' : 'раскрыть') + ' перевод'
      );
      row.setAttribute('aria-expanded', String(visible));
    } else {
      row.removeAttribute?.('aria-label');
      row.removeAttribute?.('aria-expanded');
    }
    const profile = participants.find(p => p.id === event.speaker_id);
    const speakers = $('showParticipants').value === 'show';
    row.setAttribute('data-speaker-color', speakers ? profile?.color || 'unknown' : 'unknown');
    row.classList.toggle('self-message', speakers && profile?.is_self === true);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    if (speakers) {
      const picker = document.createElement('select');
      picker.className = 'speaker-picker';
      picker.setAttribute('aria-label', 'Участник этой реплики');
      picker.add(new Option('Не определён', ''));
      for (const p of participants)
        picker.add(new Option(p.name, p.id));
      picker.value = event.speaker_id || '';
      picker.onchange = () => {
        for (const part of event.parts) {
          assignSpeaker(part, picker.value || null, participants);
          moduleBus.publish('speaker_assignment', {
            caption_id: part.id,
            ...part.speaker_assignment,
            speaker_id: part.speaker_id
          });
        }
        renderConversation();
        renderHistory();
      };
      meta.append(picker);
    }
    if (speakers)
      row.append(meta);
    const interlinear =
      words &&
      mode !== 'off' &&
      event.source_language !== event.target_language &&
      $('showOriginal').value !== 'hide';
    // In calm mode, commit the complete word layout once instead of resizing
    // it for every streamed meaning. Peek dialogs can still read ready words.
    const glossReady =
      event.demo || event.gloss_status === 'ready' || $('readingMode').value === 'live';
    const displayedGlosses =
      interlinear && glossReady && (visible || mode === 'peek')
        ? validateGlosses(event.text, event.glosses)
        : [];
    const inlineHints = interlinear;
    const original = document.createElement('p');
    original.className = 'message-original';
    if (interlinear)
      renderAnnotated(
        original,
        event.text,
        displayedGlosses,
        event.target_language,
        mode === 'peek'
          ? {
              concealed,
              onPeek: index => peekWord(event.parts[0], (event.sourceOffset || 0) + index)
            }
          : { concealed }
      );
    else
      original.textContent = event.text;
    original.hidden =
      $('showOriginal').value === 'hide' &&
      mode !== 'off' &&
      event.source_language !== event.target_language;
    setLanguage(original, event.source_language);
    row.append(original);
    if (event.source_language !== event.target_language && mode !== 'off') {
      const translated = document.createElement('p');
      translated.className = 'message-translation';
      if (event.translation && visible) {
        translated.textContent = event.translation;
        setLanguage(translated, event.target_language);
      } else {
        translated.className += ' pending';
        translated.textContent =
          event.final === false
            ? 'Перевод после паузы…'
            : ({
                pending: 'Ожидает перевода…',
                translating: 'Переводим…',
                error: 'Не удалось перевести.',
                overflow: 'Очередь заполнена. Переведи эту фразу по кнопке.',
                cancelled: 'Перевод приостановлен.',
                unavailable: 'Переводчик пока недоступен.',
                on_demand: 'Перевод по нажатию.',
                off: 'Перевод по нажатию.'
              })[event.translation_status] || 'Перевод по нажатию.';
      }
      if (!inlineHints && !concealed)
        row.append(translated);
      if (
        !inlineHints &&
        event.translation &&
        ['provisional', 'streaming', 'error'].includes(event.translation_status)
      ) {
        const label = document.createElement('small');
        label.className = 'translation-draft';
        label.textContent =
          event.translation_status === 'error'
            ? 'Перевод не завершён · можно повторить'
            : 'Перевод уточняется…';
        row.append(label);
      }
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      if (
        mode !== 'peek' &&
        event.final !== false &&
        (!event.translation ||
          !visible ||
          ['error', 'overflow', 'cancelled'].includes(event.translation_status)) &&
        !['pending', 'translating', 'streaming'].includes(event.translation_status)
      ) {
        const button = document.createElement('button');
        button.className = 'quiet';
        button.textContent =
          event.translation_status === 'error'
            ? 'Повторить перевод'
            : event.translation
              ? 'Показать перевод'
              : 'Перевести';
        button.disabled = !event.translation && !config?.translator;
        button.onclick = () => {
          for (const part of event.parts) {
            part.revealed = true;
            if (
              !part.translation ||
              ['error', 'overflow', 'cancelled'].includes(part.translation_status)
            )
              requestTranslation(part, true);
          }
          renderConversation();
        };
        actions.append(button);
      }
      if (
        words &&
        visible &&
        event.translation &&
        ['error', 'overflow', 'cancelled', 'unavailable'].includes(event.gloss_status) &&
        !event.demo
      ) {
        const note = document.createElement('span');
        note.textContent = !config?.gloss?.ready
          ? 'Подстрочный перевод недоступен'
          : ({
              pending: 'Переводим слова…',
              empty: 'Перевод не завершён',
              error: 'Не все слова переведены',
              overflow: 'Перевод слов отложен',
              cancelled: 'Перевод слов приостановлен'
            })[event.gloss_status] || 'Готовим перевод слов…';
        actions.append(note);
        if (['error', 'overflow', 'cancelled'].includes(event.gloss_status)) {
          const retry = document.createElement('button');
          retry.className = 'quiet';
          retry.textContent = 'Повторить';
          retry.disabled = !config?.gloss?.ready;
          retry.onclick = () => {
            for (const part of event.parts)
              requestGloss(part, null, true);
          };
          actions.append(retry);
        }
      }
      if (actions.children.length)
        row.append(actions);
    }
  }
  $('translationNotice').hidden = true;
  if (followConversation)
    feed.scrollTop = feed.scrollHeight;
  else
    restoreReadingAnchor(feed, anchor);
  $('jumpLatest').hidden = followConversation || !messages.size;
}
$('messageFeed').onscroll = () => {
  const feed = $('messageFeed');
  followConversation = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 8;
  $('jumpLatest').hidden = followConversation || !messages.size;
};
// A deliberate upward gesture takes control immediately, before a new token lands.
$('messageFeed').addEventListener?.(
  'wheel',
  event => {
    if (event.deltaY < 0)
      followConversation = false;
  },
  { passive: true }
);
let touchY;
$('messageFeed').addEventListener?.(
  'touchstart',
  event => {
    touchY = event.touches[0]?.clientY;
  },
  { passive: true }
);
$('messageFeed').addEventListener?.(
  'touchmove',
  event => {
    if (touchY != null && event.touches[0]?.clientY > touchY + 4)
      followConversation = false;
  },
  { passive: true }
);
$('jumpLatest').onclick = () => {
  followConversation = true;
  renderConversation();
};
window.addEventListener('resize', () => renderConversation());
function removeDemo() {
  for (const [id, event] of messages)
    if (event.demo)
    messages.delete(id);
  demoActive = false;
}
function renderHistory() {
  const container = $('history');
  container.replaceChildren();
  if (!history.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'История живёт только в этой вкладке. Сохраняешь её ты.';
    container.append(p);
  }
  for (const event of [...history].reverse()) {
    const row = document.createElement('div');
    row.className = 'phrase';
    const time = document.createElement('time');
    time.textContent = new Date(event.created_at).toLocaleTimeString('ru', {
      hour: '2-digit',
      minute: '2-digit'
    });
    const content = document.createElement('div');
    if (event.speaker_id) {
      const name = document.createElement('small');
      name.textContent = participants.find(p => p.id === event.speaker_id)?.name || 'Участник';
      content.append(name);
    }
    const text = document.createElement('p');
    text.textContent = event.text;
    if ($('translationLayout').value === 'words' && event.glosses?.length)
      renderAnnotated(text, event.text, event.glosses, event.target_language);
    setLanguage(text, event.source_language);
    content.append(text);
    if (
      event.translation &&
      event.source_language !== event.target_language &&
      !($('translationLayout').value === 'words' && event.glosses?.length)
    ) {
      const translation = document.createElement('small');
      translation.textContent = event.translation;
      setLanguage(translation, event.target_language);
      content.append(translation);
    }
    row.append(time, content);
    container.append(row);
  }
  $('save').disabled = $('saveJson').disabled = history.length === 0;
}
function show(event, keep = true) {
  current = event;
  messages.set(event.id, event);
  $('latency').textContent = demoActive
    ? 'ПРИМЕР'
    : event.processing_ms == null
      ? 'ТЕКСТ'
      : `${event.engine === 'qwen' ? 'Qwen' : 'Whisper'} · ${(event.processing_ms / 1000).toFixed(1)} с`;
  if (keep && event.final !== false && !event.demo)
    remember(event);
  showTranslation();
}
function remember(event) {
  moduleBus.publish('caption', event);
  messages.set(event.id, event);
  const index = history.findIndex(item => item.id === event.id);
  if (index === -1)
    history.push(event);
  else
    history[index] = event;
  if (!$('historyPanel').hidden)
    renderHistory();
}
async function post(path, body, type = 'audio/wav', signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Session-Token': config.token },
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
function cancelTranslations() {
  cancelGlosses();
  translationEpoch++;
  for (const { event } of translationQueue.items)
    if (['pending', 'translating', 'streaming'].includes(event.translation_status))
      event.translation_status = 'cancelled';
  if (
    activeTranslation &&
    ['pending', 'translating', 'streaming'].includes(activeTranslation.event.translation_status)
  )
    activeTranslation.event.translation_status = 'cancelled';
  activeTranslation?.controller?.abort();
  translationQueue.clear();
  pendingPartial = null;
  partialSubmitted.clear();
}
function requestTranslation(event, force = false) {
  const partial = event.final === false;
  if (
    partial &&
    ($('readingMode').value !== 'live' ||
      !config?.features?.live_translation ||
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
  if (!config?.translator) {
    event.translation_status = 'unavailable';
    showTranslation();
    return;
  }
  const job = {
    event,
    epoch: translationEpoch,
    target: event.target_language,
    source: event.source_language,
    text: event.text,
    revision: event.revision || 1,
    final: !partial
  };
  if (partial) {
    if (event.text.trim().length < 8)
      return;
    const last = partialSubmitted.get(event.id);
    // At most one pending draft; refresh roughly every two seconds of audio.
    if (last && (event.text === last.text || event.audio_seconds - last.audio < 1.5))
      return;
    partialSubmitted.set(event.id, { text: event.text, audio: event.audio_seconds });
    pendingPartial = job;
    if (!event.translation)
      event.translation_status = 'pending';
  } else {
    if (pendingPartial?.event.id === event.id)
      pendingPartial = null;
    partialSubmitted.delete(event.id);
    if (
      translationQueue.items.some(item => item.event.id === event.id) ||
      (activeTranslation?.final && activeTranslation.event.id === event.id)
    )
      return;
    if (force)
      event.revealed = true;
    event.translation_status = 'pending';
    const rejected = translationQueue.push(job);
    if (rejected)
      rejected.event.translation_status = 'overflow';
  }
  showTranslation();
  drainTranslations();
}
async function translateJob(job, onPartial) {
  const payload = JSON.stringify({
    caption_id: job.event.id,
    text: job.text,
    source_language: job.source,
    target_language: job.target
  });
  if (!config?.features?.translation_streaming)
    return post('/api/translate', payload, 'application/json', job.controller.signal);
  const response = await fetch('/api/translate-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': config.token },
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
async function drainTranslations() {
  if (translating)
    return;
  translating = true;
  try {
    while (translationQueue.length || pendingPartial) {
      let job = translationQueue.shift();
      if (!job) {
        job = pendingPartial;
        pendingPartial = null;
      }
      if (job.epoch !== translationEpoch || messages.get(job.event.id) !== job.event)
        continue;
      job.controller = new AbortController();
      activeTranslation = job;
      job.event.translation_status = 'translating';
      showTranslation();
      const valid = () =>
        job.epoch === translationEpoch &&
        messages.get(job.event.id) === job.event &&
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
        lastTranslated = job.event;
        job.event.translated_text = job.text;
        moduleBus.publish('translation', {
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
        activeTranslation = null;
      }
      showTranslation();
      if (!$('historyPanel').hidden)
        renderHistory();
    }
  } finally {
    translating = false;
    showTranslation();
    drainGlosses();
  }
}
function glossEnabled(event) {
  return $('translationLayout').value === 'words' &&
    $('showOriginal').value !== 'hide' &&
    $('translationMode').value !== 'off' &&
    ($('translationMode').value !== 'tap' || event.revealed) &&
    ($('readingMode').value === 'live' || event.final !== false) &&
    config?.gloss?.ready &&
    !event.demo &&
    event.source_language !== event.target_language
  ;
}
function cancelGlosses() {
  glossEpoch++;
  for (const job of glossQueue.items)
    job.event.gloss_status = 'cancelled';
  glossQueue.clear();
  if (activeGloss) {
    activeGloss.event.gloss_status = 'cancelled';
    activeGloss.controller.abort();
  }
}
function requestGloss(event, translated = null, force = false) {
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
  if (activeGloss?.event === event && activeGloss.text === text && activeGloss.epoch === glossEpoch)
    return;
  if (glossQueue.items.some(job => job.event === event && job.text === text))
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
    epoch: glossEpoch
  };
  const dropped = glossQueue.push(job);
  if (dropped)
    dropped.event.gloss_status = 'overflow';
  if (dropped !== job)
    event.gloss_status = 'pending';
  drainGlosses();
}
async function glossJob(job, onPartial) {
  const payload = JSON.stringify({
    caption_id: job.id,
    text: job.text,
    translation: job.translation,
    source_language: job.source,
    target_language: job.target
  });
  if (!config?.features?.gloss_streaming)
    return post('/api/gloss', payload, 'application/json', job.controller.signal);
  const response = await fetch('/api/gloss-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': config.token },
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
async function drainGlosses() {
  if (glossing)
    return;
  glossing = true;
  try {
    while (glossQueue.length) {
      // Avoid starting optional word work while recognition or phrase translation is queued.
      if (
        $('readingMode').value !== 'live' &&
        (processing || queue.length || translating || translationQueue.length)
      )
        break;
      // Completed phrases take priority; queued drafts are coalesced by ID.
      const finalIndex = glossQueue.items.findIndex(job => job.final);
      const job = finalIndex < 0 ? glossQueue.shift() : glossQueue.items.splice(finalIndex, 1)[0];
      const valid = () =>
        job.epoch === glossEpoch &&
        messages.get(job.id) === job.event &&
        glossEnabled(job.event) &&
        job.event.source_language === job.source &&
        job.event.target_language === job.target &&
        compatibleSource(job.event.text, job.text);
      if (!valid())
        continue;
      job.controller = new AbortController();
      activeGloss = job;
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
        moduleBus.publish('interlinear', {
          caption_id: job.id,
          text: job.text,
          glosses: job.event.glosses
        });
      } catch {
        if (valid())
          job.event.gloss_status = 'error';
      } finally {
        activeGloss = null;
      }
      showTranslation();
      if (!$('historyPanel').hidden)
        renderHistory();
    }
  } finally {
    glossing = false;
    showTranslation();
  }
}
function queueExistingGlosses() {
  // Switching layouts should not enqueue an entire long conversation.
  for (const event of [...messages.values()].slice(-8))
    requestGloss(event);
}
async function drain() {
  if (processing)
    return;
  processing = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (job.transcriptEpoch !== transcriptEpoch)
        continue;
      try {
        const params = new URLSearchParams({
          language: job.language,
          engine: job.engine,
          caption_id: job.id,
          revision: job.revision,
          final: job.final,
          interval: job.interval
        });
        let event = await post(`/api/transcribe?${params}`, encodeWav(job.audio, job.rate));
        if (job.transcriptEpoch !== transcriptEpoch)
          continue;
        event.target_language = job.target;
        event.sequence = job.sequence;
        event.capture_session = job.capture_session;
        event.start_seconds = job.start_seconds;
        event.speech_end_seconds = job.speech_end_seconds;
        event.end_reason = job.end_reason;
        event.speaker_id = null;
        event.speaker_assignment = null;
        event.lag_ms = Math.round(performance.now() - job.capturedAt);
        status(!running ? 'Завершаю фразу' : queue.length ? 'Распознаю' : 'Слушаю');
        // An empty final clears a tentative hallucination instead of saving it.
        if (!event.text) {
          if (event.final) {
            messages.delete(event.id);
            if (current?.id === event.id)
              current = null;
            showTranslation();
          }
          continue;
        }
        // Preserve the object referenced by in-flight translations across ASR revisions.
        const previous = messages.get(event.id);
        if (previous) {
          if (previous.gloss_text && !compatibleSource(event.text, previous.gloss_text)) {
            previous.glosses = [];
            previous.gloss_text = null;
            previous.gloss_status = null;
          }
          if (activeGloss?.event === previous && !compatibleSource(event.text, activeGloss.text))
            activeGloss.controller.abort();
          const { translation, speaker_id, speaker_assignment, ...revision } = event;
          Object.assign(previous, revision);
          event = previous;
        }
        if (event.final && $('readingMode').value !== 'live') {
          acceptFinal(event);
          continue;
        }
        if (!current || event.sequence >= (current.sequence || 0))
          show(event, false);
        else {
          messages.set(event.id, event);
          showTranslation();
        }
        if (event.final)
          remember(event);
        requestTranslation(event);
      } catch (e) {
        if (job.transcriptEpoch === transcriptEpoch)
          status(e.message);
      }
    }
  } finally {
    processing = false;
    drainGlosses();
  }
}
function controls() {
  document.body.classList.toggle('is-listening', running);
  $('listen').textContent = starting
    ? 'Включаем микрофон…'
    : running
      ? 'Остановить'
      : 'Начать слушать';
  $('listen').classList.toggle('active', running);
  $('listen').disabled = starting || (!running && !liveReady);
  for (const id of [
    'language',
    'targetLanguage',
    'engine',
    'interval',
    'threshold',
    'sentencePause',
    'swap'
  ])
    $(id).disabled = running || starting;
  $('demo').disabled = $('clear').disabled = starting;
  $('translateText').disabled =
    starting ||
    running ||
    !config ||
    (!config.translator && $('language').value !== $('targetLanguage').value);
}
function stop() {
  flushCapture?.();
  flushCapture = null;
  generation++;
  running = false;
  if (capture)
    capture.port.onmessage = null;
  source?.disconnect();
  capture?.disconnect();
  silent?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  context?.close().catch(() => {});
  source = capture = silent = stream = context = null;
  $('meter').value = 0;
  controls();
  showTranslation();
  status('Микрофон выключен');
}
async function start() {
  if (running)
    return stop();
  if (starting)
    return;
  removeDemo();
  current = null;
  lastTranslated = null;
  $('mode').textContent = 'Живые субтитры';
  showTranslation();
  starting = true;
  controls();
  const epoch = ++generation;
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Микрофон требует localhost или HTTPS.');
    const openedStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false
    });
    if (epoch !== generation) {
      openedStream.getTracks().forEach(t => t.stop());
      return;
    }
    stream = openedStream;
    const openedContext = new AudioContext();
    context = openedContext;
    await openedContext.resume();
    await openedContext.audioWorklet.addModule('/capture-worklet.js');
    if (epoch !== generation) {
      openedStream.getTracks().forEach(t => t.stop());
      await openedContext.close().catch(() => {});
      return;
    }
    const phrases = new LiveBuffer(
      context.sampleRate,
      Number($('interval').value),
      Number($('threshold').value),
      8,
      Number($('sentencePause').value || 1.2)
    );
    const sessionId = crypto.randomUUID();
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'capture');
    silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture).connect(silent).connect(context.destination);
    running = true;
    status('Слушаю');
    const capturedPair = {
      language: $('language').value,
      target: $('targetLanguage').value,
      engine: $('engine').value,
      interval: Number($('interval').value)
    };
    const viewEpoch = transcriptEpoch,
      rate = context.sampleRate;
    const submit = update => {
      if (!update)
        return;
      const dropped = queue.push({
        ...update,
        id: sessionId + '_' + update.sequence,
        sequence: epoch * 1000000 + update.sequence,
        capturedAt: performance.now(),
        rate,
        transcriptEpoch: viewEpoch,
        capture_session: sessionId,
        ...capturedPair
      });
      if (dropped)
        status('Распознавание не успевает: часть речи пропущена. Попробуй интервал 2 с.');
      drain();
    };
    flushCapture = () => submit(phrases.flush());
    capture.port.onmessage = ({ data }) => {
      if (!running || epoch !== generation)
        return;
      const { rms, update } = phrases.push(data);
      $('meter').value = rms;
      submit(update);
    };
    stream.getAudioTracks()[0].onended = () => stop();
  } catch (e) {
    stop();
    status(
      e.name === 'NotAllowedError'
        ? 'Доступ к микрофону не разрешён. Разреши его в браузере.'
        : e.message
    );
  } finally {
    starting = false;
    controls();
    renderConversation();
  }
}
function pairChanged() {
  savePreferences();
  removeDemo();
  // Past captions keep the language pair they were captured with.
  current = null;
  lastTranslated = null;
  $('mode').textContent = 'Живые субтитры';
  $('latency').textContent =
    `${$('language').value.toUpperCase()} → ${$('targetLanguage').value.toUpperCase()}`;
  showTranslation();
  controls();
}
$('language').onchange = $('targetLanguage').onchange = pairChanged;
$('swap').onclick = () => {
  const old = $('language').value;
  $('language').value = $('targetLanguage').value;
  $('targetLanguage').value = old;
  pairChanged();
};
for (const id of ['interval', 'threshold', 'sentencePause'])
  $(id).onchange = savePreferences;
$('engine').onchange = () => {
  savePreferences();
  liveReady = Boolean(config?.engines?.[$('engine').value]?.ready);
  controls();
  status(config?.engines?.[$('engine').value]?.message || 'Движок не установлен');
};
$('listen').onclick = start;
$('translationMode').onchange = () => {
  savePreferences();
  cancelTranslations();
  lastTranslated = null;
  for (const event of messages.values())
    event.revealed = false;
  if (['always', 'peek'].includes($('translationMode').value))
    for (const event of messages.values()) {
      if (
        (!event.translation || event.translation_status !== 'ready') &&
        !event.demo &&
        event.final !== false
      )
        requestTranslation(event);
    }
  queueExistingGlosses();
  showTranslation();
};
const examples = {
  en: 'Shall we meet at the café at eight?',
  es: '¿Nos vemos en la cafetería a las ocho?',
  ru: 'Встретимся в кафе в восемь?',
  fr: 'On se retrouve au café à huit heures ?',
  de: 'Treffen wir uns um acht im Café?',
  it: 'Ci vediamo al bar alle otto?',
  pt: 'Nos encontramos no café às oito?',
  zh: '我们八点在咖啡馆见面好吗？',
  ja: '8時にカフェで会いませんか？',
  ar: 'هل نلتقي في المقهى الساعة الثامنة؟'
};
$('demo').onclick = () => {
  if (starting || running)
    return;
  removeDemo();
  demoActive = true;
  $('mode').textContent = 'Пример разговора';
  status('Демо');
  const source = $('language').value,
    target = $('targetLanguage').value;
  const pairs =
    source === 'es' && target === 'ru'
      ? [
          ['Hola, ¿cómo estás?', 'Привет, как дела?'],
          ['¿Nos vemos en la cafetería a las ocho?', 'Встретимся в кафе в восемь?'],
          ['Sí, perfecto. Te espero allí.', 'Да, отлично. Буду ждать тебя там.']
        ]
      : [[examples[source], examples[target]]];
  const prepared = [
    ['Привет,', 'как', 'ты?'],
    ['друг друга', 'увидим', 'в', 'артикль', 'кафе', 'в', 'артикль', 'восемь?'],
    ['Да,', 'отлично.', 'Тебя', 'жду', 'там.']
  ];
  for (const [index, pair] of pairs.entries()) {
    const event = {
      id: 'demo' + index,
      demo: true,
      source_language: source,
      target_language: target,
      text: pair[0],
      translation: pair[1],
      translation_status: 'ready',
      revealed: !['tap', 'peek'].includes($('translationMode').value),
      final: true,
      created_at: new Date().toISOString(),
      speaker_id: index === 1 ? 'self' : 'guest'
    };
    if (source === 'es' && target === 'ru') {
      event.glosses = sourceUnits(pair[0]).map(unit => ({
        ...unit,
        meaning: prepared[index][unit.index]
      }));
      event.gloss_status = 'ready';
    }
    show(event, false);
  }
};
$('translateText').onclick = () => {
  const text = $('manualText').value.trim();
  if (!text || !config || running || starting)
    return;
  removeDemo();
  $('mode').textContent = 'Перевод текста';
  status('Микрофон выключен');
  const event = {
    version: 1,
    type: 'caption',
    id: crypto.randomUUID(),
    source_language: $('language').value,
    target_language: $('targetLanguage').value,
    text,
    translation: null,
    final: true,
    input: 'text',
    created_at: new Date().toISOString()
  };
  assignSpeaker(event, 'self', participants);
  const chunks = splitFinalCaption(event);
  for (const chunk of chunks) {
    show(chunk);
    requestTranslation(chunk, $('translationMode').value === 'tap');
  }
  $('settingsDialog').close();
  setPanel('reader');
};
$('clear').onclick = () => {
  wordPeek = null;
  $('wordDialog').close();
  stop();
  transcriptEpoch++;
  queue.clear();
  cancelTranslations();
  messages.clear();
  followConversation = true;
  demoActive = false;
  history = [];
  current = null;
  $('manualText').value = '';
  pairChanged();
  renderHistory();
};
function download(json) {
  const value = json
    ? JSON.stringify(
        {
          schema_version: 2,
          exported_at: new Date().toISOString(),
          participants,
          captions: history
        },
        null,
        2
      )
    : history
        .map(
          e =>
            `${participants.find(p=>p.id===e.speaker_id)?.name || 'Участник не определён'}\n[${e.source_language} → ${e.target_language}] ${e.text}${e.translation ? '\n' + e.translation : ''}`
        )
        .join('\n\n');
  const url = URL.createObjectURL(
      new Blob([value], { type: json ? 'application/json' : 'text/plain;charset=utf-8' })
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = `claro-conversation.${json ? 'json' : 'txt'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save').onclick = () => download(false);
$('saveJson').onclick = () => download(true);
$('display').onclick = () => {
  const on = document.body.classList.toggle('lens');
  $('display').textContent = on ? 'Выйти из фокуса' : 'Фокус';
};
function setPanel(panel) {
  $('readerPanel').hidden = panel !== 'reader';
  $('historyPanel').hidden = panel !== 'history';
  $('conversationTab').setAttribute('aria-pressed', String(panel === 'reader'));
  $('historyTab').setAttribute('aria-pressed', String(panel === 'history'));
  if (panel === 'history')
    renderHistory();
  else
    renderConversation();
}
function layoutChanged() {
  const words = $('translationLayout').value === 'words';
  $('lineMode').setAttribute('aria-pressed', String(!words));
  $('wordMode').setAttribute('aria-pressed', String(words));
  $('layoutNote').textContent = words
    ? 'Место для перевода закреплено под каждым словом. Нажми на перевод, чтобы прочитать его полностью.'
    : 'Перевод появляется под своей фразой. Сообщения остаются в ленте.';
  if (words)
    queueExistingGlosses();
  else
    cancelGlosses();
  savePreferences();
  showTranslation();
  renderHistory();
}
$('conversationTab').onclick = () => setPanel('reader');
$('historyTab').onclick = () => setPanel('history');
$('openSettings').onclick = () => $('settingsDialog').showModal();
$('closeSettings').onclick = () => $('settingsDialog').close();
$('lineMode').onclick = () => {
  $('translationLayout').value = 'line';
  layoutChanged();
};
$('wordMode').onclick = () => {
  $('translationLayout').value = 'words';
  layoutChanged();
};
$('translationLayout').onchange = layoutChanged;

window.addEventListener('pagehide', stop);
async function health() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok)
      throw new Error();
    config = await response.json();
    if (!engineInitialized) {
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem('claro.preferences.v1') || '{}').engine;
      } catch {}
      $('engine').value = config.engines?.[saved] ? saved : config.default_engine;
      engineInitialized = true;
    }
    for (const option of $('engine').options)
      option.disabled = !config.engines?.[option.value];
    const engineState = config.engines?.[$('engine').value];
    liveReady = Boolean(engineState?.ready);
    $('translationInfo').textContent = config.translator
      ? `Оригинал и перевод работают отдельно. ${config.gloss?.ready ? 'Подстрочный перевод покрывает каждое слово и готовится отдельно.' : 'Для подстрочного перевода нужна локальная модель qwen3:4b.'}`
      : `${config.translation?.message || translationMessage}. Инструкция подключения — в README.`;
    if (!running && !starting && !demoActive)
      status(liveReady ? 'Готово' : engineState?.message || 'Модель не установлена');
    controls();
    renderConversation();
  } catch {
    liveReady = false;
    controls();
    if (!running)
      status('Нет связи с локальным сервером. Запусти start.command.');
  }
}
function renderParticipantSettings() {
  const list = $('participantList');
  list.replaceChildren();
  for (const profile of participants) {
    const row = document.createElement('div');
    row.className = 'participant-setting';
    const name = document.createElement('input');
    name.value = profile.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', profile.is_self ? 'Моё имя' : 'Имя участника');
    name.onchange = () => {
      profile.name = name.value.trim() || (profile.is_self ? 'Я' : 'Участник');
      saveParticipants();
    };
    const color = document.createElement('select');
    color.setAttribute('aria-label', 'Цвет: ' + profile.name);
    const labels = ['Синий', 'Зелёный', 'Оранжевый', 'Розовый', 'Бирюзовый'];
    SPEAKER_COLORS.forEach((value, i) => color.add(new Option(labels[i], value)));
    color.value = profile.color;
    color.onchange = () => {
      profile.color = color.value;
      saveParticipants();
    };
    row.append(name, color);
    list.append(row);
  }
}
function saveParticipants() {
  try {
    localStorage.setItem('claro.participants.v1', JSON.stringify(participants));
  } catch {}
  renderConversation();
  renderHistory();
}
$('addParticipant').onclick = () => {
  if (participants.length >= 30)
    return;
  participants.push({
    id: crypto.randomUUID(),
    name: 'Участник ' + participants.length,
    color: SPEAKER_COLORS[participants.length % SPEAKER_COLORS.length],
    is_self: false
  });
  saveParticipants();
  renderParticipantSettings();
};
for (const id of ['showOriginal', 'showParticipants', 'textSize', 'readingMode'])
  $(id).onchange = () => {
    savePreferences();
    if (id === 'showOriginal') {
      if ($('showOriginal').value === 'hide')
        cancelGlosses();
      else
        queueExistingGlosses();
    }
    renderConversation();
  };
$('closeWord').onclick = () => {
  wordPeek = null;
  $('wordDialog').close();
};
$('wordDialog').addEventListener?.('close', () => {
  wordPeek = null;
});
renderParticipantSettings();
pairChanged();
layoutChanged();
health();
setInterval(health, 4000);
