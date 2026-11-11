import { languageByCode } from './languages.js';

export const $ = id => document.getElementById(id);

export function status(text) {
  $('status').textContent = text;
}

export function setLanguage(element, code) {
  element.lang = code || '';
  element.dir = languageByCode(code)?.dir || 'auto';
}
