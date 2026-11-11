import { state } from './state.js';
import { $, status, initializeSheets } from './dom.js';
import { loadPreferences, savePreferences, applyAppearance } from './preferences.js';
import { renderConversation } from './render.js';
import { controls, start, stop } from './capture.js';
import { queueExistingGlosses, cancelGlosses } from './gloss-jobs.js';
import { showDemo } from './demo.js';
import { renderParticipantSettings, addParticipant } from './participant-settings.js';
import { initializeAppInstall, pairChanged, layoutChanged, setPanel, health, recognitionStatus, download, translationModeChanged, translateText } from './settings.js';
import { initializePersistence, newConversation, deleteConversation } from './persistence.js';
import { initializeLibrary, configureLibrary, openLibrary, renderLibrary } from './library.js';

loadPreferences();
initializeSheets();
initializeLibrary();
initializeAppInstall();

for (const id of ['theme', 'palette'])
  $(id).onchange = () => {
    savePreferences();
    applyAppearance();
  };
for (const [settingsId, sourceId] of [
  ['settingsLanguage', 'language'],
  ['settingsTargetLanguage', 'targetLanguage']
])
  $(settingsId).onchange = () => {
    $(sourceId).value = $(settingsId).value;
    pairChanged();
  };

let recordingStarted = null;
export function updateRecordingIndicator(now = Date.now()) {
  if (state.running && recordingStarted === null)
    recordingStarted = now;
  if (!state.running)
    recordingStarted = null;
  const elapsed = recordingStarted === null ? 0 : Math.floor((now - recordingStarted) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  $('recordingTime').textContent = `${minutes}:${seconds}`;
  const level = state.running ? Math.min(4, Math.ceil(Number($('meter').value) / 0.025)) : 0;
  $('soundLevel').setAttribute('data-level', String(level));
}
setInterval(updateRecordingIndicator, 100);

$('messageFeed').onscroll = () => {
  const feed = $('messageFeed');
  state.followConversation = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 8;
  $('jumpLatest').hidden = state.followConversation || !state.messages.size;
};
// A deliberate upward gesture takes control immediately, before a new token lands.
$('messageFeed').addEventListener?.(
  'wheel',
  event => {
    if (event.deltaY < 0)
      state.followConversation = false;
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
      state.followConversation = false;
  },
  { passive: true }
);
$('jumpLatest').onclick = () => {
  state.followConversation = true;
  renderConversation();
};
window.addEventListener('resize', () => {
  $('wordDialog').close();
  renderConversation();
  renderLibrary();
});
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
  state.liveReady = Boolean(state.config?.engines?.[$('engine').value]?.ready);
  controls();
  status(recognitionStatus());
};
$('listen').onclick = start;
$('translationMode').onchange = translationModeChanged;
$('demo').onclick = showDemo;
$('copySetup').onclick = async () => {
  try {
    await navigator.clipboard.writeText('npm run setup');
    $('copySetup').textContent = 'Команда скопирована';
  } catch {
    $('copySetup').textContent = 'Скопируйте команду npm run setup';
  }
};
$('translateText').onclick = translateText;
$('clear').onclick = async () => {
  const cleared = await newConversation();
  if (state.config?.features?.sessions && cleared !== false)
    setPanel('reader');
};
$('deleteConversation').onclick = deleteConversation;
$('saveConversations').onchange = () => {
  savePreferences();
  initializePersistence();
  configureLibrary();
  if (!$('historyPanel').hidden)
    openLibrary();
};
$('save').onclick = () => download(false);
$('saveJson').onclick = () => download(true);
$('display').onclick = () => {
  const on = document.body.classList.toggle('lens');
  $('display').textContent = on ? 'Выйти из фокуса' : 'Фокус';
};
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
$('addParticipant').onclick = addParticipant;
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
    renderLibrary();
  };
$('closeWord').onclick = () => {
  state.wordPeek = null;
  $('wordDialog').close();
};
$('wordDialog').addEventListener?.('close', () => {
  state.wordPeek = null;
});
renderParticipantSettings();
pairChanged();
layoutChanged();
health();
setInterval(health, 4000);
