import { languageByCode } from './languages.js';

export const $ = id => document.getElementById(id);

export function status(text) {
  $('status').textContent = text;
}

export function setLanguage(element, code) {
  element.lang = code || '';
  element.dir = languageByCode(code)?.dir || 'auto';
}

export function openWordDialog(anchor) {
  document.querySelector?.('.word-selected')?.classList.remove('word-selected');
  anchor?.classList.add('word-selected');
  const dialog = $('wordDialog');
  if (dialog.open)
    return;
  if (window.matchMedia?.('(min-width: 720px)').matches)
    dialog.show();
  else
    dialog.showModal();
}

export function initializeSheets() {
  for (const id of ['wordDialog', 'settingsDialog']) {
    const dialog = $(id);
    let gesture = null;
    dialog.addEventListener?.('pointerdown', event => {
      if (!window.matchMedia?.('(max-width: 719px)').matches)
        return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientY <= bounds.top + 80 && !event.target.closest('button')) {
        gesture = { y: event.clientY, time: event.timeStamp };
        dialog.setPointerCapture(event.pointerId);
      }
    });
    dialog.addEventListener?.('pointerup', event => {
      if (!gesture)
        return;
      const distance = event.clientY - gesture.y;
      const duration = Math.max(1, event.timeStamp - gesture.time);
      gesture = null;
      if (distance > 120 || (distance > 12 && distance / duration > 0.11))
        dialog.close();
    });
    dialog.addEventListener?.('pointercancel', () => { gesture = null; });
    dialog.addEventListener?.('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientY < bounds.top || event.clientY > bounds.bottom ||
          event.clientX < bounds.left || event.clientX > bounds.right))
        dialog.close();
    });
  }
  document.addEventListener?.('pointerdown', event => {
    const dialog = $('wordDialog');
    if (dialog.open && !dialog.matches(':modal') && !dialog.contains(event.target) &&
        !event.target.closest('.word-source,.word-meaning'))
      dialog.close();
  });
  document.addEventListener?.('keydown', event => {
    if (event.key === 'Escape')
      $('wordDialog').close();
  });
  $('wordDialog').addEventListener?.('close', () => {
    document.querySelector('.word-selected')?.classList.remove('word-selected');
  });
}
