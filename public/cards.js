import { state } from './state.js';
import { $, setLanguage } from './dom.js';
import { sessionRequest } from './persistence.js';

const grades = ['again', 'hard', 'good', 'easy'];
const gradeNames = ['Снова', 'Трудно', 'Хорошо', 'Легко'];
const addedWords = new Set();
const addingWords = new Set();
let wordCandidate = null;
let cards = [];
let stats = { due: 0, total: 0, next_due_at: null };
let reviewQueue = [];
let reviewing = false;
let revealed = false;
let busy = false;
let requestVersion = 0;

function wordKey(card) {
  return `${card.source_language}:${card.source.toLowerCase()}`;
}

export function configureCards() {
  const available = Boolean(state.config?.features?.cards);
  $('cardsTab').hidden = !available;
  $('cardsPanel').hidden = !available || state.panel !== 'cards';
  $('wordAddCard').hidden = !available;
  updateWordButton();
}

function updateWordButton() {
  const key = wordCandidate && wordKey(wordCandidate);
  const added = key && addedWords.has(key);
  const adding = key && addingWords.has(key);
  $('wordAddCard').textContent = added ? 'В карточках' : adding ? 'Сохраняем…' : 'В карточки';
  $('wordAddCard').disabled = !wordCandidate || added || adding;
}

function trimPunctuation(text) {
  const trimmed = text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
  return trimmed || text;
}

export function prepareWordCard(event, span) {
  wordCandidate = span?.meaning ? {
    source: trimPunctuation(span.source),
    meaning: trimPunctuation(span.meaning),
    source_language: event.source_language,
    target_language: event.target_language,
    example: event.text,
    example_translation: event.translation || null,
    session_id: event.session_id || state.sessionId,
    turn_id: event.id
  } : null;
  $('wordCardError').textContent = '';
  configureCards();
}

export async function addWordCard() {
  if (!state.config?.features?.cards || !wordCandidate || $('wordAddCard').disabled)
    return;
  const candidate = { ...wordCandidate };
  const key = wordKey(candidate);
  $('wordCardError').textContent = '';
  addingWords.add(key);
  updateWordButton();
  try {
    await sessionRequest('/api/cards', 'POST', candidate);
    addedWords.add(key);
  } catch {
    if (wordCandidate && wordKey(wordCandidate) === key)
      $('wordCardError').textContent = 'Не удалось сохранить карточку. Попробуйте ещё раз.';
  } finally {
    addingWords.delete(key);
    updateWordButton();
  }
}

function whenDue(value) {
  if (new Date(value).getTime() <= Date.now())
    return 'Пора повторить';
  return new Date(value).toLocaleString('ru', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
  });
}

function showError(text = '') {
  $('cardsError').textContent = text;
  $('cardsRetry').hidden = !text;
}

function renderOverview() {
  $('cardsOverview').hidden = false;
  $('cardsReview').hidden = true;
  $('cardsDue').textContent = `На сегодня: ${stats.due}`;
  $('cardsStart').hidden = !stats.due;
  $('cardsEmpty').hidden = stats.total > 0;
  $('cardsFinished').hidden = !stats.total || stats.due > 0;
  $('cardsNext').textContent = stats.next_due_at ? `Следующее повторение: ${whenDue(stats.next_due_at)}` : '';
  const list = $('cardsList');
  list.replaceChildren();
  for (const card of cards) {
    const row = document.createElement('article');
    row.className = 'card-row';
    const source = document.createElement('h3');
    source.textContent = card.source;
    setLanguage(source, card.source_language);
    const meaning = document.createElement('p');
    meaning.className = 'card-row-meaning';
    meaning.textContent = card.meaning;
    setLanguage(meaning, card.target_language);
    const due = document.createElement('time');
    due.dateTime = card.due_at;
    due.textContent = whenDue(card.due_at);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const edit = document.createElement('button');
    edit.className = 'quiet';
    edit.textContent = 'Изменить';
    edit.onclick = () => editCard(card, row);
    const remove = document.createElement('button');
    remove.className = 'quiet';
    remove.textContent = 'Удалить';
    remove.onclick = async () => {
      if (!confirm('Удалить карточку?'))
        return;
      remove.disabled = true;
      try {
        await sessionRequest(`/api/cards/${card.id}`, 'DELETE');
        addedWords.delete(wordKey(card));
        await openCards();
      } catch {
        remove.disabled = false;
        showError('Не удалось удалить карточку. Попробуйте ещё раз.');
      }
    };
    actions.append(edit, remove);
    row.append(source, meaning, due, actions);
    list.append(row);
  }
}

function editCard(card, row) {
  const form = document.createElement('form');
  form.className = 'card-edit';
  const inputs = {};
  for (const [field, title] of [['source', 'Слово или выражение'], ['meaning', 'Значение']]) {
    const label = document.createElement('label');
    label.textContent = title;
    const input = document.createElement('textarea');
    input.value = card[field];
    input.maxLength = 300;
    input.required = true;
    input.rows = 2;
    setLanguage(input, field === 'source' ? card.source_language : card.target_language);
    label.append(input);
    form.append(label);
    inputs[field] = input;
  }
  const save = document.createElement('button');
  save.className = 'quiet';
  save.type = 'submit';
  save.textContent = 'Сохранить';
  const cancel = document.createElement('button');
  cancel.className = 'quiet';
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  cancel.onclick = renderOverview;
  const error = document.createElement('p');
  error.setAttribute('role', 'status');
  form.onsubmit = async event => {
    event.preventDefault();
    if (!inputs.source.value.trim() || !inputs.meaning.value.trim()) {
      error.textContent = 'Заполните слово и значение.';
      return;
    }
    save.disabled = true;
    try {
      await sessionRequest(`/api/cards/${card.id}`, 'PATCH', {
        source: inputs.source.value.trim(), meaning: inputs.meaning.value.trim()
      });
      addedWords.delete(wordKey(card));
      await openCards();
    } catch {
      save.disabled = false;
      error.textContent = 'Не удалось изменить карточку. Проверьте, нет ли такого слова в списке.';
    }
  };
  form.append(save, cancel, error);
  row.replaceChildren(form);
}

export async function openCards() {
  if (!state.config?.features?.cards)
    return;
  const version = ++requestVersion;
  reviewing = false;
  busy = true;
  showError();
  $('cardsStart').disabled = true;
  $('cardsOverview').hidden = false;
  $('cardsReview').hidden = true;
  $('cardsLoading').hidden = false;
  try {
    const result = await sessionRequest(`/api/cards?limit=${Number.MAX_SAFE_INTEGER}`);
    if (version !== requestVersion)
      return;
    cards = result.cards;
    stats = result.stats;
    addedWords.clear();
    for (const card of cards)
      addedWords.add(wordKey(card));
    renderOverview();
  } catch {
    if (version === requestVersion)
      showError('Не удалось открыть карточки. Попробуйте ещё раз.');
  } finally {
    if (version === requestVersion) {
      busy = false;
      $('cardsLoading').hidden = true;
      $('cardsStart').disabled = false;
    }
  }
}

function renderExample(card) {
  const container = $('cardExample');
  const text = card.example || '';
  container.replaceChildren();
  const start = text.toLowerCase().indexOf(card.source.toLowerCase());
  if (start < 0) {
    container.textContent = text;
    return;
  }
  const mark = document.createElement('mark');
  mark.textContent = text.slice(start, start + card.source.length);
  container.append(document.createTextNode(text.slice(0, start)), mark,
    document.createTextNode(text.slice(start + card.source.length)));
}

function renderReview() {
  const card = reviewQueue[0];
  revealed = false;
  $('cardsOverview').hidden = true;
  $('cardsReview').hidden = false;
  $('cardSource').textContent = card.source;
  setLanguage($('cardSource'), card.source_language);
  renderExample(card);
  setLanguage($('cardExample'), card.source_language);
  $('cardMeaning').textContent = card.meaning;
  setLanguage($('cardMeaning'), card.target_language);
  $('cardExampleTranslation').textContent = card.example_translation || '';
  setLanguage($('cardExampleTranslation'), card.target_language);
  $('cardAnswer').hidden = true;
  $('cardGrades').hidden = true;
  $('cardReveal').hidden = false;
  $('cardFace').setAttribute('aria-expanded', 'false');
  for (const [index, grade] of grades.entries()) {
    const button = $(`cardGrade${index + 1}`);
    button.textContent = `${gradeNames[index]} · ${card.review_labels[grade]}`;
    button.disabled = false;
  }
}

export async function startCardReview() {
  if (busy || !state.config?.features?.cards)
    return;
  const version = ++requestVersion;
  busy = true;
  $('cardsStart').disabled = true;
  showError();
  try {
    const result = await sessionRequest(`/api/cards?due=1&limit=${Number.MAX_SAFE_INTEGER}`);
    if (version !== requestVersion || state.panel !== 'cards')
      return;
    reviewQueue = result.cards;
    if (!reviewQueue.length) {
      await openCards();
      return;
    }
    reviewing = true;
    renderReview();
  } catch {
    if (version === requestVersion)
      showError('Не удалось начать повторение. Попробуйте ещё раз.');
  } finally {
    if (version === requestVersion) {
      busy = false;
      $('cardsStart').disabled = false;
    }
  }
}

export function revealCard() {
  if (!reviewing || busy)
    return;
  revealed = true;
  $('cardAnswer').hidden = false;
  $('cardGrades').hidden = false;
  $('cardReveal').hidden = true;
  $('cardFace').setAttribute('aria-expanded', 'true');
}

export async function gradeCard(grade) {
  if (!reviewing || !revealed || busy || !grades.includes(grade))
    return;
  const version = requestVersion;
  busy = true;
  showError();
  for (let index = 1; index <= 4; index++)
    $(`cardGrade${index}`).disabled = true;
  try {
    await sessionRequest(`/api/cards/${reviewQueue[0].id}/review`, 'POST', { grade });
    if (version !== requestVersion || state.panel !== 'cards')
      return;
    reviewQueue.shift();
    if (reviewQueue.length)
      renderReview();
    else
      await openCards();
  } catch {
    if (version === requestVersion)
      showError('Не удалось сохранить оценку. Повторите нажатие.');
  } finally {
    if (version === requestVersion) {
      busy = false;
      for (let index = 1; index <= 4; index++)
        $(`cardGrade${index}`).disabled = false;
    }
  }
}

export function leaveCards() {
  requestVersion++;
  reviewing = false;
  reviewQueue = [];
  busy = false;
}

export function initializeCards() {
  configureCards();
  $('wordAddCard').onclick = addWordCard;
  $('cardsStart').onclick = startCardReview;
  $('cardsRetry').onclick = openCards;
  $('cardsBack').onclick = openCards;
  $('cardFace').onclick = revealCard;
  $('cardReveal').onclick = revealCard;
  for (const [index, grade] of grades.entries())
    $(`cardGrade${index + 1}`).onclick = () => gradeCard(grade);
  window.addEventListener('keydown', event => {
    if (state.panel !== 'cards' || !reviewing || event.repeat ||
        event.target?.closest?.('input,textarea,select,[contenteditable],dialog[open]'))
      return;
    if (event.key === ' ') {
      event.preventDefault();
      revealCard();
    } else if (revealed && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      gradeCard(grades[Number(event.key) - 1]);
    }
  });
}
