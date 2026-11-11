import { recognitionMessage } from './readiness.js';
import { state } from './state.js';
import { $, status } from './dom.js';
import { savePreferences } from './preferences.js';
import { assignSpeaker } from './participants.js';
import { splitFinalCaption } from './reading.js';
import { renderConversation } from './render.js';
import { showTranslation, removeDemo, show, renderHistory } from './render-history.js';
import { controls, stop } from './capture.js';
import { requestTranslation, cancelTranslations } from './translation-jobs.js';
import { queueExistingGlosses, cancelGlosses } from './gloss-jobs.js';
import { initializePersistence } from './persistence.js';
import { configureLibrary, openLibrary, renderLibrary } from './library.js';
import { configureCards, openCards, leaveCards } from './cards.js';

export function pairChanged() {
  $('settingsLanguage').value = $('language').value;
  $('settingsTargetLanguage').value = $('targetLanguage').value;
  savePreferences();
  removeDemo();
  // Past captions keep the language pair they were captured with.
  state.current = null;
  state.lastTranslated = null;
  $('mode').textContent = 'Живые субтитры';
  $('latency').textContent =
    `${$('language').value.toUpperCase()} → ${$('targetLanguage').value.toUpperCase()}`;
  showTranslation();
  controls();
}

export function download(json, captions = state.history, participants = state.participants) {
  const value = json
    ? JSON.stringify(
        {
          schema_version: 2,
          exported_at: new Date().toISOString(),
          participants,
          captions
        },
        null,
        2
      )
    : captions
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

export function setPanel(panel) {
  if (panel === 'cards' && !state.config?.features?.cards)
    return;
  if (state.panel === 'cards' && panel !== 'cards')
    leaveCards();
  if (panel === 'watch' && !navigator.mediaDevices?.getDisplayMedia)
    return;
  state.panel = panel;
  state.wordPeek = null;
  $('wordDialog').close();
  $('readerPanel').hidden = !['reader', 'watch'].includes(panel);
  $('readerPanel').setAttribute('aria-label', panel === 'watch' ? 'Просмотр' : 'Разговор');
  $('historyPanel').hidden = panel !== 'history';
  $('conversationTab').setAttribute('aria-pressed', String(panel === 'reader'));
  $('historyTab').setAttribute('aria-pressed', String(panel === 'history'));
  $('watchTab').setAttribute('aria-pressed', String(panel === 'watch'));
  $('cardsTab').setAttribute('aria-pressed', String(panel === 'cards'));
  configureLibrary();
  configureCards();
  if (panel === 'cards')
    return openCards();
  if (panel === 'history') {
    if (state.config?.features?.sessions)
      return openLibrary();
    renderHistory();
  } else
    renderConversation();
}

export function layoutChanged() {
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
  renderLibrary();
}

export function recognitionStatus() {
  const engine = state.config?.engines?.[$('engine').value];
  $('engineStatus').textContent = engine?.message || 'Движок недоступен';
  return recognitionMessage(state.config, $('engine').value);
}

export async function health() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok)
      throw new Error();
    state.config = await response.json();
    if (!state.engineInitialized) {
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem('claro.preferences.v1') || '{}').engine;
      } catch {}
      $('engine').value = state.config.engines?.[saved] ? saved : state.config.default_engine;
      state.engineInitialized = true;
    }
    for (const option of $('engine').options)
      option.disabled = !state.config.engines?.[option.value];
    const engineState = state.config.engines?.[$('engine').value];
    state.liveReady = Boolean(engineState?.ready);
    $('translationInfo').textContent = state.config.translator
      ? `Оригинал и перевод работают отдельно. ${state.config.gloss?.ready ? 'Подстрочный перевод покрывает каждое слово и готовится отдельно.' : 'Для подстрочного перевода нужна локальная модель qwen3:4b.'}`
      : 'Перевод недоступен. Запустите npm run setup или проверьте настройки Ollama по инструкции docs/setup.md.';
    if (!state.running && !state.starting && !state.demoActive)
      status(recognitionStatus());
    controls();
    configureCards();
    if (state.panel === 'cards' && !state.config?.features?.cards)
      setPanel('reader');
    await initializePersistence();
    if (configureLibrary() && !$('historyPanel').hidden && state.config?.features?.sessions)
      openLibrary();
    renderConversation();
  } catch {
    state.liveReady = false;
    controls();
    if (!state.running)
      status('Нет связи с локальным сервером. Запусти start.command.');
  }
}

export function translationModeChanged() {
  savePreferences();
  cancelTranslations();
  state.lastTranslated = null;
  for (const event of state.messages.values())
    event.revealed = false;
  if (['always', 'peek'].includes($('translationMode').value))
    for (const event of state.messages.values()) {
      if (
        (!event.translation || event.translation_status !== 'ready') &&
        !event.demo &&
        event.final !== false
      )
        requestTranslation(event);
    }
  queueExistingGlosses();
  showTranslation();
}

export function translateText() {
  const text = $('manualText').value.trim();
  if (!text || !state.config || state.running || state.starting)
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
  assignSpeaker(event, 'self', state.participants);
  const chunks = splitFinalCaption(event);
  for (const chunk of chunks) {
    show(chunk);
    requestTranslation(chunk, $('translationMode').value === 'tap');
  }
  $('settingsDialog').close();
  setPanel('reader');
}

export function clearConversation({ preserveCapture = false } = {}) {
  state.wordPeek = null;
  $('wordDialog').close();
  if (!preserveCapture)
    stop();
  state.transcriptEpoch++;
  state.queue.clear();
  cancelTranslations();
  state.messages.clear();
  state.followConversation = true;
  state.demoActive = false;
  state.history = [];
  state.current = null;
  $('manualText').value = '';
  pairChanged();
  renderHistory();
}

export function initializeAppInstall() {
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('appInstallHint').textContent = 'Claro установлено как приложение';
  });
  $('installApp').onclick = async () => {
    if (!installPrompt) {
      $('appInstallHint').textContent = 'В Chrome: меню ⋮ → Установить Claro';
      return;
    }
    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      $('appInstallHint').textContent = choice.outcome === 'accepted'
        ? 'Установка Claro запрошена'
        : 'В Chrome: меню ⋮ → Установить Claro';
    } catch {
      $('appInstallHint').textContent = 'В Chrome: меню ⋮ → Установить Claro';
    }
  };
}
