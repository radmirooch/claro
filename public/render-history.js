import { state } from './state.js';
import { $, setLanguage, openWordDialog } from './dom.js';
import { renderAnnotated, sourceUnits, validateGlosses } from './annotations.js';
import { renderConversation } from './render.js';
import { requestTranslation } from './translation-jobs.js';
import { requestGloss } from './gloss-jobs.js';
import { prepareWordCard } from './cards.js';

export function showTranslation() {
  renderConversation();
  refreshWordPeek();
}

export function refreshWordPeek() {
  if (!state.wordPeek)
    return;
  const event = state.wordPeek.record || state.messages.get(state.wordPeek.id);
  if (!event || event.text !== state.wordPeek.text) {
    state.wordPeek = null;
    $('wordDialog').close();
    return;
  }
  const unit = sourceUnits(event.text)[state.wordPeek.index],
    span = validateGlosses(event.text, event.glosses, state.wordPeek.record ? 300 : undefined).find(
      span => span.start < unit.end && span.end > unit.start
    );
  const meaning = span?.meaning;
  prepareWordCard(event, span);
  $('wordPhrase').textContent = event.text;
  setLanguage($('wordPhrase'), event.source_language);
  $('wordTranslation').textContent = event.translation || '';
  setLanguage($('wordTranslation'), event.target_language);
  let missingMeaning = 'Значение слова не сохранено.';
  if (!state.wordPeek.record)
    missingMeaning = ['error', 'overflow', 'unavailable'].includes(event.gloss_status) || !state.config?.gloss?.ready
      ? 'Перевод слова недоступен. Можно повторить перевод сообщения.'
      : $('translationLayout').value !== 'words'
        ? 'Чтобы получить значение, выберите «Под словами».'
        : 'Перевод слова ещё готовится…';
  $('wordMeaning').textContent = meaning || missingMeaning;
}

export function peekWord(event, index, anchor, readOnly = false) {
  if (!readOnly)
    publishLookup(event, index);
  state.wordPeek = { id: event.id, text: event.text, index, ...(readOnly ? { record: event } : {}) };
  const unit = sourceUnits(event.text)[index];
  const span = validateGlosses(event.text, event.glosses, readOnly ? 300 : undefined).find(
    item => item.start < unit.end && item.end > unit.start
  );
  $('wordOriginal').textContent = span?.source || unit.source;
  setLanguage($('wordOriginal'), event.source_language);
  refreshWordPeek();
  openWordDialog(anchor);
  if (readOnly)
    return;
  if (!event.translation)
    requestTranslation(event);
  else if (event.gloss_status !== 'ready')
    requestGloss(event, null, ['error', 'overflow', 'cancelled'].includes(event.gloss_status));
}

export function publishLookup(event, index) {
  if (!state.running || event.demo)
    return;
  const unit = sourceUnits(event.text)[index];
  if (!unit)
    return;
  const span = validateGlosses(event.text, event.glosses).find(
    item => item.start < unit.end && item.end > unit.start
  );
  state.moduleBus.publish('lookup', {
    caption_id: event.id,
    index,
    source: span?.source || unit.source,
    meaning: span?.meaning || null,
    source_language: event.source_language,
    target_language: event.target_language,
    at: new Date().toISOString()
  });
}

export function revealMessage(event) {
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

export function removeDemo() {
  for (const [id, event] of state.messages)
    if (event.demo)
    state.messages.delete(id);
  state.demoActive = false;
}

export function renderHistory() {
  const container = $('history');
  container.replaceChildren();
  if (!state.history.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Здесь появятся готовые реплики разговора.';
    container.append(p);
  }
  let previousSpeaker;
  for (const event of [...state.history].reverse()) {
    const row = document.createElement('div');
    row.className = 'phrase';
    const time = document.createElement('time');
    time.textContent = new Date(event.created_at).toLocaleTimeString('ru', {
      hour: '2-digit',
      minute: '2-digit'
    });
    const content = document.createElement('div');
    if ($('showParticipants').value === 'show' && event.speaker_id &&
        event.speaker_id !== previousSpeaker) {
      const name = document.createElement('small');
      name.textContent = state.participants.find(p => p.id === event.speaker_id)?.name || 'Участник';
      content.append(name);
    }
    previousSpeaker = event.speaker_id;
    const text = document.createElement('p');
    text.textContent = event.text;
    if ($('translationLayout').value === 'words' && event.glosses?.length)
      renderAnnotated(text, event.text, event.glosses, event.target_language, { translation: event.translation });
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
  $('save').disabled = $('saveJson').disabled = state.history.length === 0;
}

export function show(event, keep = true) {
  state.current = event;
  state.messages.set(event.id, event);
  $('latency').textContent = state.demoActive
    ? 'ПРИМЕР'
    : event.processing_ms == null
      ? 'ТЕКСТ'
      : `${event.engine === 'qwen' ? 'Qwen' : 'Whisper'} · ${(event.processing_ms / 1000).toFixed(1)} с`;
  if (keep && event.final !== false && !event.demo)
    remember(event);
  showTranslation();
}

export function remember(event) {
  state.moduleBus.publish('caption', event);
  state.messages.set(event.id, event);
  const index = state.history.findIndex(item => item.id === event.id);
  if (index === -1)
    state.history.push(event);
  else
    state.history[index] = event;
  if (!$('historyPanel').hidden)
    renderHistory();
}
