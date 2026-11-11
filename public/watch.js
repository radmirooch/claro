import { state } from './state.js';
import { $, setLanguage } from './dom.js';
import { start, stop } from './capture.js';
import { setPanel } from './settings.js';
import { renderMessages } from './render.js';
import { sourceUnits, validateGlosses } from './annotations.js';
import { publishLookup } from './render-history.js';
import { requestTranslation } from './translation-jobs.js';
import { requestGloss } from './gloss-jobs.js';

const displayReason = 'Звук вкладки работает в Chrome и Edge на компьютере';
const pipReason = 'Окно поверх видео работает в Chrome и Edge';
let pipWindow = null;
let pipList = null;
let pipMeaning = null;
let pipPeek = null;
let pipOpening = false;
const pipRows = new Map();

export function renderWatch() {
  const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const phone = window.matchMedia?.('(pointer: coarse) and (width < 768px)').matches || false;
  const watching = state.panel === 'watch';
  const recording = state.running && state.captureSource === 'display';
  $('readerTitle').textContent = watching ? 'Просмотр' : 'Разговор';
  $('messageFeed').setAttribute('aria-label', watching ? 'Сообщения просмотра' : 'Сообщения разговора');
  $('watchTab').hidden = phone;
  $('watchTab').disabled = !supported;
  $('watchTab').title = supported ? '' : displayReason;
  $('watchUnavailable').hidden = supported || phone;
  $('watchUnavailable').textContent = displayReason;
  $('watchTools').hidden = !watching;
  $('watchHeader').hidden = !watching || !recording;
  $('watchSource').textContent = state.captureLabel;
  $('watchStop').disabled = !recording;
  $('watchChoose').hidden = recording;
  $('watchChoose').disabled = !supported || state.starting || !state.liveReady;
  $('watchChoose').textContent = state.starting && state.captureSource === 'display'
    ? 'Открываем источник…'
    : state.watchError ? 'Выбрать заново' : 'Выбрать вкладку';
  $('watchHint').hidden = recording;
  $('watchError').textContent = state.watchError;
  $('watchError').hidden = !state.watchError;
  const pipSupported = Boolean(window.documentPictureInPicture?.requestWindow);
  $('watchPip').hidden = !pipSupported;
  $('watchPip').disabled = state.sessionKind !== 'watch' || pipOpening;
  $('pipUnavailable').hidden = pipSupported;
  $('pipUnavailable').textContent = pipReason;
  $('listen').hidden = watching;
  $('capturePrivacy').textContent = watching
    ? 'Звук включается только после выбора источника'
    : 'Микрофон включается только по кнопке';
  $('meter').setAttribute('aria-label', state.captureSource === 'display' ? 'Уровень звука вкладки' : 'Уровень микрофона');
  document.body.classList.toggle('is-watching', watching);
  $('conversationTab').classList.toggle('is-recording', state.running && state.captureSource === 'mic');
  $('watchTab').classList.toggle('is-recording', recording);
}

export function initializeWatch() {
  $('watchTab').onclick = () => setPanel('watch');
  $('watchChoose').onclick = () => start({ source: 'display' });
  $('watchStop').onclick = stop;
  $('watchPip').onclick = openPip;
  window.matchMedia?.('(pointer: coarse) and (width < 768px)').addEventListener('change', renderWatch);
  if (typeof MutationObserver !== 'undefined')
    new MutationObserver(syncPipAppearance).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette']
    });
  renderWatch();
}

function syncPipAppearance() {
  if (!pipWindow || pipWindow.closed)
    return;
  for (const name of ['data-theme', 'data-palette'])
    pipWindow.document.documentElement.setAttribute(name, document.documentElement.getAttribute(name));
  pipWindow.document.body.setAttribute('data-text-size', $('textSize').value || 'normal');
}

export async function openPip() {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  if (!window.documentPictureInPicture?.requestWindow || pipOpening)
    return;
  pipOpening = true;
  renderWatch();
  try {
    const opened = await window.documentPictureInPicture.requestWindow({ width: 480, height: 220 });
    pipWindow = opened;
    pipRows.clear();
    pipPeek = null;
    const doc = opened.document;
    doc.title = 'Claro — субтитры';
    doc.documentElement.lang = 'ru';
    for (const stylesheet of document.querySelectorAll('link[rel="stylesheet"]')) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = stylesheet.href;
      doc.head.append(link);
    }
    doc.body.className = 'pip-body';
    pipList = doc.createElement('main');
    pipList.className = 'pip-messages message-list';
    pipList.setAttribute('role', 'log');
    pipList.setAttribute('aria-label', 'Субтитры просмотра');
    pipList.setAttribute('aria-live', 'polite');
    pipMeaning = doc.createElement('p');
    pipMeaning.className = 'pip-word';
    pipMeaning.setAttribute('role', 'status');
    doc.body.replaceChildren(pipList);
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        pipPeek = null;
        renderPip();
      }
    });
    opened.addEventListener('pagehide', () => {
      if (pipWindow !== opened)
        return;
      pipWindow = null;
      pipList = pipMeaning = pipPeek = null;
      pipRows.clear();
    });
    renderPip();
  } catch {
    state.watchError = 'Не удалось открыть окно поверх видео. Попробуйте снова.';
  } finally {
    pipOpening = false;
    renderWatch();
  }
}

function peekPipWord(event, index) {
  publishLookup(event, index);
  if (pipPeek?.id === event.id && pipPeek.index === index)
    pipPeek = null;
  else {
    pipPeek = { id: event.id, index, text: event.text };
    if (!event.translation)
      requestTranslation(event);
    else if (event.gloss_status !== 'ready')
      requestGloss(event, null, ['error', 'overflow', 'cancelled'].includes(event.gloss_status));
  }
  renderPip();
}

export function renderPip() {
  if (!pipWindow || pipWindow.closed)
    return;
  syncPipAppearance();
  const events = state.sessionKind === 'watch' ? [...state.messages.values()] : [];
  const recent = events.filter(event => event.final !== false).slice(-3);
  const draft = events.filter(event => event.final === false).at(-1);
  if (draft)
    recent.push(draft);
  pipMeaning.remove();
  renderMessages(recent, pipList, pipRows, { compact: true, onPeek: peekPipWord });
  const event = recent.find(event => event.id === pipPeek?.id);
  if (!event || event.text !== pipPeek.text)
    pipPeek = null;
  if (pipPeek) {
    const unit = sourceUnits(event.text)[pipPeek.index];
    const span = validateGlosses(event.text, event.glosses).find(
      item => item.start < unit.end && item.end > unit.start
    );
    pipMeaning.textContent = span?.meaning || (!state.config?.gloss?.ready ||
      ['error', 'unavailable', 'overflow'].includes(event.gloss_status)
      ? 'Перевод слова недоступен. Можно повторить перевод сообщения.'
      : $('translationLayout').value !== 'words'
        ? 'Чтобы получить значение, выберите «Под словами».'
        : 'Перевод слова ещё готовится…');
    setLanguage(pipMeaning, event.target_language);
    pipRows.get(event.id).append(pipMeaning);
  }
  pipWindow.scrollTo(0, pipWindow.document.body.scrollHeight);
}
