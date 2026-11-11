import { state } from './state.js';
import { $ } from './dom.js';
import { languageByCode } from './languages.js';
import { renderMessages } from './render.js';
import { sessionRequest, restoredTurn, initializePersistence, removeSavedConversation } from './persistence.js';
import { download, setPanel } from './settings.js';

let sessions = [];
let selected = null;
let savedTurns = [];
let requestVersion = 0;
let loading = false;
let failed = false;
let savingAvailable;
const savedRows = new Map();

function savingEnabled() {
  return Boolean(state.config?.features?.sessions) && $('saveConversations').value === 'on';
}

function conversationTitle(session) {
  return session.title || session.preview?.trim().split(/\s+/u).slice(0, 8).join(' ') || 'Без названия';
}

function currentSession(session) {
  return session.id === state.sessionId && !session.ended_at;
}

function dayLabel(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.getTime() === today.getTime())
    return 'Сегодня';
  if (day.getTime() === yesterday.getTime())
    return 'Вчера';
  return date.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function turnCount(count) {
  const last = count % 10;
  const hundred = count % 100;
  if (last === 1 && hundred !== 11)
    return `${count} реплика`;
  if (last >= 2 && last <= 4 && (hundred < 12 || hundred > 14))
    return `${count} реплики`;
  return `${count} реплик`;
}

function listMessage(text, action, onClick) {
  const container = $('libraryList');
  const message = document.createElement('p');
  message.className = 'empty';
  message.textContent = text;
  container.append(message);
  if (action) {
    const button = document.createElement('button');
    button.className = 'quiet';
    button.textContent = action;
    button.onclick = onClick;
    container.append(button);
  }
}

export function configureLibrary() {
  const supported = Boolean(state.config?.features?.sessions);
  $('legacyHistory').hidden = supported;
  $('library').hidden = !supported;
  $('captureBar').hidden = state.panel === 'cards' || (supported && !$('historyPanel').hidden);
  const available = savingEnabled();
  const changed = available !== savingAvailable;
  if (changed) {
    savingAvailable = available;
    requestVersion++;
    selected = null;
    savedTurns = [];
    savedRows.clear();
    sessions = [];
    loading = false;
    failed = false;
    renderLibrary();
  }
  return changed;
}

export function renderLibrary() {
  $('libraryListView').hidden = Boolean(selected);
  $('libraryDetail').hidden = !selected;
  if (selected) {
    $('libraryTitle').textContent = conversationTitle(selected);
    $('libraryContinue').hidden = !currentSession(selected);
    const watchUnavailable = selected.kind === 'watch' &&
      (!navigator.mediaDevices?.getDisplayMedia ||
        window.matchMedia?.('(pointer: coarse) and (width < 768px)').matches);
    $('libraryContinue').disabled = Boolean(watchUnavailable);
    $('libraryContinue').title = watchUnavailable
      ? 'Звук вкладки работает в Chrome и Edge на компьютере' : '';
    renderMessages(savedTurns, $('libraryMessages'), savedRows, { readOnly: true });
    return;
  }
  const container = $('libraryList');
  container.replaceChildren();
  $('librarySearch').hidden = !savingEnabled();
  container.setAttribute('aria-busy', String(loading));
  if (!savingEnabled()) {
    listMessage('Сохранение разговоров выключено', 'Настройки', () => $('settingsDialog').showModal());
    return;
  }
  if (loading) {
    listMessage('Загрузка…');
    return;
  }
  if (failed) {
    listMessage('Не удалось открыть библиотеку', 'Повторить', openLibrary);
    return;
  }
  if (!sessions.length) {
    listMessage('Пока нет разговоров', 'Начать разговор', () => setPanel('reader'));
    return;
  }
  const query = $('librarySearch').value.trim().toLocaleLowerCase('ru');
  const matching = sessions.filter(session =>
    `${session.title || ''} ${session.preview || ''}`.toLocaleLowerCase('ru').includes(query));
  if (!matching.length) {
    listMessage('Ничего не нашлось', 'Сбросить поиск', () => {
      $('librarySearch').value = '';
      renderLibrary();
    });
    return;
  }
  const groups = new Map();
  for (const session of matching) {
    const date = new Date(session.started_at);
    const label = dayLabel(date);
    if (!groups.has(label)) {
      const section = document.createElement('section');
      section.className = 'library-group';
      const heading = document.createElement('h2');
      heading.textContent = label;
      section.append(heading);
      groups.set(label, section);
      container.append(section);
    }
    const row = document.createElement('button');
    row.className = 'library-row';
    row.setAttribute('data-session-id', session.id);
    row.onclick = () => openSavedConversation(session.id);
    const title = document.createElement('span');
    title.className = 'library-row-title';
    title.textContent = conversationTitle(session);
    const meta = document.createElement('span');
    meta.className = 'library-meta';
    const source = languageByCode(session.source_language)?.label || session.source_language;
    const target = languageByCode(session.target_language)?.label || session.target_language;
    meta.textContent = `${source} → ${target} · ${turnCount(session.turn_count)}`;
    const time = document.createElement('time');
    time.dateTime = session.started_at;
    time.textContent = date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    row.append(title, meta, time);
    if (currentSession(session)) {
      const active = document.createElement('span');
      active.className = 'library-current';
      active.textContent = 'Сейчас';
      row.append(active);
    }
    groups.get(label).append(row);
  }
}

export async function openLibrary() {
  const version = ++requestVersion;
  selected = null;
  savedTurns = [];
  savedRows.clear();
  state.wordPeek = null;
  $('wordDialog').close();
  loading = savingEnabled();
  failed = false;
  renderLibrary();
  if (!savingEnabled())
    return;
  try {
    await initializePersistence();
    if (version !== requestVersion || !savingEnabled())
      return;
    // The existing limit parameter allows searching the whole local library.
    const result = await sessionRequest(`/api/sessions?limit=${Number.MAX_SAFE_INTEGER}`);
    if (version !== requestVersion || !savingEnabled())
      return;
    sessions = result.sessions;
  } catch {
    if (version !== requestVersion)
      return;
    failed = true;
  }
  if (version === requestVersion) {
    loading = false;
    renderLibrary();
  }
}

export async function openSavedConversation(id) {
  if (!savingEnabled())
    return;
  const version = ++requestVersion;
  loading = true;
  failed = false;
  renderLibrary();
  try {
    const result = await sessionRequest(`/api/sessions/${id}`);
    if (version !== requestVersion || !savingEnabled())
      return;
    savedTurns = [...result.turns]
      .sort((a, b) => a.seq - b.seq)
      .map(turn => ({ ...restoredTurn(turn), session_id: result.session.id }));
    selected = { ...result.session, preview: savedTurns[0]?.text };
    savedRows.clear();
    $('libraryMessages').replaceChildren();
    $('libraryRenameForm').hidden = true;
    $('libraryExports').hidden = true;
    $('libraryExport').setAttribute('aria-expanded', 'false');
    $('libraryActionError').hidden = true;
  } catch {
    if (version !== requestVersion)
      return;
    failed = true;
  }
  if (version === requestVersion) {
    loading = false;
    renderLibrary();
    $('historyPanel').scrollTop = 0;
  }
}

async function renameSavedConversation(event) {
  event.preventDefault();
  if (!selected || $('libraryRenameSave').disabled)
    return;
  const title = $('libraryName').value.trim();
  if (title.length > 120) {
    actionError('Название должно быть не длиннее 120 символов.');
    return;
  }
  const session = selected;
  $('libraryRenameSave').disabled = true;
  $('libraryActionError').hidden = true;
  try {
    const updated = await sessionRequest(`/api/sessions/${session.id}`, 'PATCH', { title: title || null });
    if (selected !== session)
      return;
    selected = { ...session, ...updated };
    $('libraryRenameForm').hidden = true;
    renderLibrary();
  } catch {
    if (selected === session)
      actionError('Не удалось переименовать разговор. Попробуй ещё раз.');
  } finally {
    $('libraryRenameSave').disabled = false;
  }
}

function actionError(text) {
  $('libraryActionError').textContent = text;
  $('libraryActionError').hidden = false;
}

async function deleteSavedConversation() {
  if (!selected || $('libraryDelete').disabled || !confirm('Удалить этот разговор с диска?'))
    return;
  const session = selected;
  $('libraryDelete').disabled = true;
  $('libraryActionError').hidden = true;
  try {
    const removed = await removeSavedConversation(session.id);
    if (!removed)
      throw new Error('Не удалось удалить разговор');
    if (selected?.id === session.id)
      await openLibrary();
  } catch {
    if (selected?.id === session.id)
      actionError('Не удалось удалить разговор. Попробуй ещё раз.');
  } finally {
    $('libraryDelete').disabled = false;
  }
}

export function initializeLibrary() {
  $('librarySearch').oninput = renderLibrary;
  $('libraryBack').onclick = openLibrary;
  $('libraryContinue').onclick = () => {
    if (selected && currentSession(selected))
      setPanel(selected.kind === 'watch' ? 'watch' : 'reader');
  };
  $('libraryRename').onclick = () => {
    $('libraryName').value = selected.title || '';
    $('libraryRenameForm').hidden = false;
    $('libraryName').focus?.();
  };
  $('libraryRenameForm').onsubmit = renameSavedConversation;
  $('libraryRenameCancel').onclick = () => { $('libraryRenameForm').hidden = true; };
  $('libraryExport').onclick = () => {
    const show = $('libraryExports').hidden;
    $('libraryExports').hidden = !show;
    $('libraryExport').setAttribute('aria-expanded', String(show));
  };
  $('libraryExportText').onclick = () => download(false, savedTurns);
  $('libraryExportJson').onclick = () => download(true, savedTurns);
  $('libraryDelete').onclick = deleteSavedConversation;
}
