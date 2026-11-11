import { state } from './state.js';
import { $, status } from './dom.js';
import { loadPreferences, savePreferences } from './preferences.js';
import { renderConversation } from './render.js';
import { controls, start, stop } from './capture.js';
import { queueExistingGlosses, cancelGlosses } from './gloss-jobs.js';
import { showDemo } from './demo.js';
import { renderParticipantSettings, addParticipant } from './participant-settings.js';
import { pairChanged, layoutChanged, setPanel, health, download, translationModeChanged, translateText } from './settings.js';
import { initializePersistence, newConversation, deleteConversation } from './persistence.js';

loadPreferences();

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
window.addEventListener('resize', () => renderConversation());
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
  status(state.config?.engines?.[$('engine').value]?.message || 'Движок не установлен');
};
$('listen').onclick = start;
$('translationMode').onchange = translationModeChanged;
$('demo').onclick = showDemo;
$('translateText').onclick = translateText;
$('clear').onclick = newConversation;
$('deleteConversation').onclick = deleteConversation;
$('saveConversations').onchange = () => {
  savePreferences();
  initializePersistence();
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
