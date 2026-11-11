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

const translationMessage = 'Переводчик пока не готов. Оригинал остаётся доступен.';

export function pairChanged() {
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

export function download(json) {
  const value = json
    ? JSON.stringify(
        {
          schema_version: 2,
          exported_at: new Date().toISOString(),
          participants: state.participants,
          captions: state.history
        },
        null,
        2
      )
    : state.history
        .map(
          e =>
            `${state.participants.find(p=>p.id===e.speaker_id)?.name || 'Участник не определён'}\n[${e.source_language} → ${e.target_language}] ${e.text}${e.translation ? '\n' + e.translation : ''}`
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
  $('readerPanel').hidden = panel !== 'reader';
  $('historyPanel').hidden = panel !== 'history';
  $('conversationTab').setAttribute('aria-pressed', String(panel === 'reader'));
  $('historyTab').setAttribute('aria-pressed', String(panel === 'history'));
  if (panel === 'history')
    renderHistory();
  else
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
      : `${state.config.translation?.message || translationMessage}. Инструкция подключения — в README.`;
    if (!state.running && !state.starting && !state.demoActive)
      status(state.liveReady ? 'Готово' : engineState?.message || 'Модель не установлена');
    controls();
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

export function clearConversation() {
  state.wordPeek = null;
  $('wordDialog').close();
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
