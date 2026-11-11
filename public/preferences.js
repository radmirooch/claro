import { LANGUAGES } from './languages.js';
import { $ } from './dom.js';

export const preferenceIds = [
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
  'readingMode',
  'saveConversations',
  'theme',
  'palette'
];

export function loadPreferences() {
  for (const id of ['language', 'targetLanguage', 'settingsLanguage', 'settingsTargetLanguage']) {
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
  applyAppearance();
}

export function applyAppearance() {
  window.claroAppearance?.apply($('theme').value, $('palette').value);
}

export function savePreferences() {
  try {
    localStorage.setItem(
      'claro.preferences.v1',
      JSON.stringify(Object.fromEntries(preferenceIds.map(id => [id, $(id).value])))
    );
  } catch {}
}
