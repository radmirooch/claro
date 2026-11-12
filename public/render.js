import { recognitionMissing } from './readiness.js';
import { state } from './state.js';
import { $, setLanguage } from './dom.js';
import { firstAppearance, renderAnnotated, validateGlosses } from './annotations.js';
import { draftTail } from './reading.js';
import { assignSpeaker } from './participants.js';
import { renderHistory, peekWord, revealMessage } from './render-history.js';
import { requestTranslation } from './translation-jobs.js';
import { requestGloss } from './gloss-jobs.js';
import { renderWatch, renderPip } from './watch.js';

export function readingAnchor(feed) {
  const bounds = feed.getBoundingClientRect?.();
  if (!bounds)
    return null;
  for (const [id, row] of state.messageRows) {
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

export function restoreReadingAnchor(feed, anchor) {
  const node = anchor && state.messageRows.get(anchor.id)?.querySelector?.(anchor.selector);
  if (node)
    feed.scrollTop +=
      node.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset;
}

export function messengerBlocks(events) {
  // A finalized phrase keeps one identity regardless of viewport or translation.
  return events.map(event => ({ ...event, parts: [event], sourceOffset: 0 }));
}

export function renderConversation() {
  const mode = $('translationMode').value;
  const feed = $('messageFeed'),
    list = $('messageList');
  const anchor = state.followConversation ? null : readingAnchor(feed);
  document.body.setAttribute('data-text-size', $('textSize').value || 'normal');
  const steady = $('readingMode').value !== 'live';
  const viewingWatch = state.panel === 'watch';
  const matchingKind = state.sessionKind === (viewingWatch ? 'watch' : 'conversation');
  const all = matchingKind ? [...state.messages.values()] : [],
    draft = steady ? all.filter(event => event.final === false).at(-1) : null;
  $('draftPanel').hidden = !draft || ($('showOriginal').value === 'hide' && mode !== 'off');
  $('draftText').textContent = draft ? draftTail(draft.text) : '';
  const modelsMissing = recognitionMissing(state.config);
  $('emptyState').hidden = all.length > 0;
  $('emptyTitle').textContent = viewingWatch
    ? 'Выберите, что смотреть'
    : modelsMissing ? 'Модели не установлены' : 'Начните разговор';
  $('demo').hidden = viewingWatch;
  // The conversation listens to the microphone; offer the tab source next to it.
  $('emptyWatch').hidden = viewingWatch || $('watchTab').hidden || $('watchTab').disabled;
  $('setupHelp').hidden = !modelsMissing;
  renderMessages(all.filter(event => !steady || event.final !== false), list, state.messageRows);
  $('translationNotice').textContent = 'Перевод недоступен';
  $('translationNotice').hidden = !state.config || Boolean(state.config.translator) || state.demoActive || mode === 'off';
  if (state.followConversation)
    feed.scrollTop = feed.scrollHeight;
  else
    restoreReadingAnchor(feed, anchor);
  $('jumpLatest').hidden = state.followConversation || !state.messages.size;
  renderWatch();
  renderPip();
}

export function renderMessages(events, list, rows, { readOnly = false, compact = false, onPeek } = {}) {
  const mode = readOnly ? 'always' : $('translationMode').value;
  const words = $('translationLayout').value === 'words';
  const blocks = messengerBlocks(events),
    blockIds = new Set(blocks.map(block => block.id));
  for (const [id, row] of rows)
    if (!blockIds.has(id)) {
      row.remove();
      rows.delete(id);
    }
  for (const [index, event] of blocks.entries()) {
    const previousSpeaker = index > 0 ? blocks[index - 1].speaker_id : undefined;
    const sameSpeaker = index > 0 && previousSpeaker === event.speaker_id;
    let row = rows.get(event.id);
    if (!row) {
      row = document.createElement('article');
      row.className = 'message';
      row.setAttribute('data-caption-id', event.id);
      rows.set(event.id, row);
      list.append(row);
    } else
      list.appendChild?.(row); // Keep continuation bubbles in source order after resize.
    const visible = mode !== 'off' && (!['tap', 'peek'].includes(mode) || event.revealed);
    const concealed = ['peek', 'tap'].includes(mode) && !visible;
    const signature = JSON.stringify([
      event,
      sameSpeaker,
      mode,
      words,
      $('showOriginal').value,
      $('showParticipants').value,
      state.participants,
      state.config?.translator,
      state.config?.gloss?.ready
    ]);
    if (row.signature === signature)
      continue;
    row.signature = signature;
    row.replaceChildren();
    row.classList.toggle('same-speaker', sameSpeaker);
    row.classList.toggle('phrase-layout', !words);
    row.classList.toggle('translation-failed', ['error', 'unavailable', 'cancelled', 'overflow'].includes(event.translation_status) ||
      ['error', 'unavailable', 'cancelled', 'overflow'].includes(event.gloss_status));
    row.classList.toggle('partial', event.final === false);
    row.classList.toggle('translation-concealed', concealed);
    row.onclick =
      ['peek', 'tap'].includes(mode)
        ? e => {
            if (e.target?.closest?.('button,select,input,a'))
              return;
            revealMessage(event);
          }
        : null;
    row.onkeydown =
      ['peek', 'tap'].includes(mode)
        ? e => {
            if (e.target === row && ['Enter', ' '].includes(e.key)) {
              e.preventDefault();
              revealMessage(event);
            }
          }
        : null;
    row.tabIndex = ['peek', 'tap'].includes(mode) ? 0 : -1;
    if (['peek', 'tap'].includes(mode)) {
      row.setAttribute(
        'aria-label',
        'Сообщение. Нажми, чтобы ' + (visible ? 'скрыть' : 'раскрыть') + ' перевод'
      );
      row.setAttribute('aria-expanded', String(visible));
    } else {
      row.removeAttribute?.('aria-label');
      row.removeAttribute?.('aria-expanded');
    }
    const profile = state.participants.find(p => p.id === event.speaker_id);
    const speakers = !compact && $('showParticipants').value === 'show';
    row.setAttribute('data-speaker-color', speakers ? profile?.color || 'unknown' : 'unknown');
    row.classList.toggle('self-message', event.speaker_id === 'self');
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    if (speakers && readOnly) {
      meta.textContent = profile?.name || 'Участник';
    }
    if (speakers && !readOnly) {
      const picker = document.createElement('select');
      picker.className = 'speaker-picker';
      picker.setAttribute('aria-label', 'Участник этой реплики');
      picker.add(new Option('Не определён', ''));
      for (const p of state.participants)
        picker.add(new Option(p.name, p.id));
      picker.value = event.speaker_id || '';
      picker.onchange = () => {
        for (const part of event.parts) {
          assignSpeaker(part, picker.value || null, state.participants);
          state.moduleBus.publish('speaker_assignment', {
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
    if (speakers && (!readOnly || !sameSpeaker))
      row.append(meta);
    const interlinear =
      words &&
      mode !== 'off' &&
      event.source_language !== event.target_language &&
      (!readOnly || Boolean(event.glosses?.length)) &&
      (readOnly || $('showOriginal').value !== 'hide');
    // In calm mode, commit the complete word layout once instead of resizing
    // it for every streamed meaning. Peek dialogs can still read ready words.
    const glossReady =
      event.demo || event.gloss_status === 'ready' || $('readingMode').value === 'live';
    const displayedGlosses =
      interlinear && glossReady && (visible || mode === 'peek')
        ? validateGlosses(event.text, event.glosses, readOnly ? 300 : undefined)
        : [];
    const inlineHints = interlinear;
    const original = document.createElement('p');
    original.className = 'message-original';
    renderAnnotated(original, event.text, interlinear ? displayedGlosses : event.glosses, event.target_language, {
      phraseLayout: !interlinear,
      animationKey: event.id,
      concealed: !interlinear || concealed,
      maxGlossLength: readOnly ? 300 : undefined,
      selectedIndex: state.wordPeek?.id === event.id ? state.wordPeek.index : null,
      onPeek: (index, anchor) => {
        if (onPeek)
          onPeek(event.parts[0], index, anchor);
        else if (readOnly)
          peekWord(event.parts[0], index, anchor, true);
        else if (mode === 'tap' && concealed) {
          peekWord(event.parts[0], index, anchor);
          revealMessage(event);
        }
        else
          peekWord(event.parts[0], (event.sourceOffset || 0) + index, anchor);
      }
    });
    original.hidden =
      !readOnly &&
      $('showOriginal').value === 'hide' &&
      mode !== 'off' &&
      event.source_language !== event.target_language;
    setLanguage(original, event.source_language);
    row.append(original);
    if (event.source_language !== event.target_language && mode !== 'off') {
      const translated = document.createElement('p');
      translated.className = 'message-translation';
      if (event.translation && visible) {
        if (firstAppearance(`translation|${event.id}|${event.translation}`))
          translated.classList.add('appearing');
        translated.textContent = event.translation;
        setLanguage(translated, event.target_language);
      } else {
        translated.className += ' pending';
        if (['pending', 'translating'].includes(event.translation_status))
          translated.className += ' loading';
        translated.textContent =
          event.final === false
            ? 'Перевод после паузы…'
            : ({
                pending: 'Ожидает перевода…',
                translating: 'Переводим…',
                error: 'Перевод не получился',
                overflow: 'Очередь заполнена. Переведи эту фразу по кнопке.',
                cancelled: 'Перевод приостановлен.',
                unavailable: 'Переводчик пока недоступен.',
                on_demand: 'Перевод по нажатию.',
                off: 'Перевод по нажатию.'
              })[event.translation_status] || 'Перевод по нажатию.';
      }
      if (!inlineHints && !concealed && (readOnly ? event.translation : event.translation || event.translation_status !== 'error'))
        row.append(translated);
      if (
        !inlineHints &&
        event.translation &&
        ['provisional', 'streaming'].includes(event.translation_status)
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
        !readOnly && !compact &&
        (mode !== 'peek' || event.translation_status === 'error') &&
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
            ? 'Повторить'
            : event.translation
              ? 'Показать перевод'
              : 'Перевести';
        button.disabled = !event.translation && !state.config?.translator;
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
        if (event.translation_status === 'error') {
          const failure = document.createElement('span');
          failure.textContent = 'Перевод не получился ·';
          actions.append(failure);
        }
        actions.append(button);
      }
      if (
        !readOnly && !compact &&
        words &&
        visible &&
        event.translation &&
        ['error', 'overflow', 'cancelled', 'unavailable'].includes(event.gloss_status) &&
        !event.demo
      ) {
        const note = document.createElement('span');
        note.textContent = !state.config?.gloss?.ready
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
          retry.disabled = !state.config?.gloss?.ready;
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
}
