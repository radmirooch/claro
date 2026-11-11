import { state } from './state.js';
import { $ } from './dom.js';
import { SPEAKER_COLORS } from './participants.js';
import { renderConversation } from './render.js';
import { renderHistory } from './render-history.js';

export function renderParticipantSettings() {
  const list = $('participantList');
  list.replaceChildren();
  for (const profile of state.participants) {
    const row = document.createElement('div');
    row.className = 'participant-setting';
    const name = document.createElement('input');
    name.value = profile.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', profile.is_self ? 'Моё имя' : 'Имя участника');
    name.onchange = () => {
      profile.name = name.value.trim() || (profile.is_self ? 'Я' : 'Участник');
      saveParticipants();
    };
    const color = document.createElement('select');
    color.setAttribute('aria-label', 'Цвет: ' + profile.name);
    const labels = ['Синий', 'Зелёный', 'Оранжевый', 'Розовый', 'Бирюзовый'];
    SPEAKER_COLORS.forEach((value, i) => color.add(new Option(labels[i], value)));
    color.value = profile.color;
    color.onchange = () => {
      profile.color = color.value;
      saveParticipants();
    };
    row.append(name, color);
    list.append(row);
  }
}

export function saveParticipants() {
  try {
    localStorage.setItem('claro.participants.v1', JSON.stringify(state.participants));
  } catch {}
  renderConversation();
  renderHistory();
}

export function addParticipant() {
  if (state.participants.length >= 30)
    return;
  state.participants.push({
    id: crypto.randomUUID(),
    name: 'Участник ' + state.participants.length,
    color: SPEAKER_COLORS[state.participants.length % SPEAKER_COLORS.length],
    is_self: false
  });
  saveParticipants();
  renderParticipantSettings();
}
