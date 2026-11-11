import { state } from './state.js';
import { $, status } from './dom.js';
import { renderConversation } from './render.js';
import { renderHistory, removeDemo } from './render-history.js';
import { clearConversation } from './settings.js';

const turnFields = [
  'text', 'source_language', 'target_language', 'created_at',
  'translation', 'translation_status', 'glosses', 'gloss_status',
  'speaker_id', 'speaker_assignment', 'source_record', 'engine', 'input', 'revision'
];
const pending = new Map();
let initialization;
let creation;
let closing = false;
let acceptingWrites = true;
let errorShown = false;
let conversationEpoch = 0;

function enabled() {
  return Boolean(state.config?.features?.sessions) && $('saveConversations').value === 'on';
}

function reportError() {
  if (errorShown)
    return;
  errorShown = true;
  status('Не удалось сохранить разговор');
}

async function request(path, method = 'GET', input) {
  const response = await fetch(path, {
    method,
    headers: {
      'X-Session-Token': state.config.token,
      'Content-Type': 'application/json'
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  if (!response.ok)
    throw new Error('Хранилище разговоров недоступно');
  return response.json();
}

function restoredTurn(turn) {
  const record = { ...turn.extra, ...turn, final: true };
  delete record.extra;
  delete record.session_id;
  if (record.translation && ['ready', undefined, null].includes(record.translation_status)) {
    record.translation_status = 'ready';
    record.translated_text = record.text;
  } else {
    record.translation = null;
    record.translation_status = 'cancelled';
  }
  if (record.glosses?.length && ['ready', undefined, null].includes(record.gloss_status)) {
    record.gloss_status = 'ready';
    record.gloss_text = record.text;
  } else {
    record.glosses = null;
    record.gloss_status = 'cancelled';
  }
  return record;
}

export function initializePersistence() {
  $('deleteConversation').hidden = !state.config?.features?.sessions;
  $('saveConversations').disabled = !state.config?.features?.sessions;
  if (!enabled())
    return;
  if (!initialization) {
    const epoch = conversationEpoch;
    initialization = (async () => {
      try {
        const result = await request('/api/sessions/active');
        if (!enabled() || epoch !== conversationEpoch || !result.session)
          return;
        state.sessionId = result.session.id;
        removeDemo();
        const restored = [...result.turns].sort((a, b) => a.seq - b.seq).map(restoredTurn);
        const localIds = new Set(state.history.map(turn => turn.id));
        state.history = [...restored.filter(turn => !localIds.has(turn.id)), ...state.history];
        for (const turn of restored)
          if (!state.messages.has(turn.id))
            state.messages.set(turn.id, turn);
        // Rebuild insertion order for the regular conversation renderer.
        state.messages = new Map([
          ...state.history.map(turn => [turn.id, turn]),
          ...state.messages
        ]);
        renderConversation();
        renderHistory();
      } catch {
        reportError();
      }
    })();
  }
  return initialization;
}

async function sessionFor(turn, epoch) {
  if (!enabled() || epoch !== conversationEpoch)
    return null;
  if (state.sessionId)
    return state.sessionId;
  if (creation) {
    const previous = creation;
    const id = await previous.promise;
    return previous.epoch === epoch ? id : sessionFor(turn, epoch);
  }
  const job = { epoch };
  creation = job;
  job.promise = request('/api/sessions', 'POST', {
    kind: 'conversation',
    source_language: turn.source_language,
    target_language: turn.target_language
  }).then(session => {
    if (epoch === conversationEpoch)
      state.sessionId = session.id;
    return session.id;
  }).finally(() => {
    creation = null;
  });
  return job.promise;
}

function findTurn(id) {
  return state.messages.get(id) || state.history.find(turn => turn.id === id);
}

function saveTurn(event) {
  if (!enabled() || !acceptingWrites)
    return;
  const id = event.caption_id || event.id;
  const turn = findTurn(id);
  if (!turn || turn.demo || turn.final === false)
    return;
  const key = `${conversationEpoch}:${id}`;
  const existing = pending.get(key);
  if (existing) {
    existing.dirty = true;
    return;
  }
  const job = { dirty: true, epoch: conversationEpoch };
  pending.set(key, job);
  job.promise = (async () => {
    try {
      await initializePersistence();
      while (job.dirty && enabled() && job.epoch === conversationEpoch) {
        job.dirty = false;
        const current = findTurn(id);
        if (!current || current.demo || current.final === false)
          return;
        const sessionId = await sessionFor(current, job.epoch);
        if (!enabled() || job.epoch !== conversationEpoch || findTurn(id) !== current)
          return;
        const input = Object.fromEntries(turnFields
          .filter(key => current[key] !== undefined)
          .map(key => [key, current[key]]));
        await request(`/api/sessions/${sessionId}/turns/${id}`, 'PUT', input);
      }
    } catch {
      reportError();
    } finally {
      pending.delete(key);
    }
  })();
}

for (const type of ['caption', 'translation', 'interlinear', 'speaker_assignment'])
  state.moduleBus.subscribe(type, saveTurn);

async function finishConversation(method) {
  if (closing)
    return;
  closing = true;
  try {
    await initialization;
    while (pending.size)
      await Promise.all([...pending.values()].map(job => job.promise));
    acceptingWrites = false;
    if (enabled() && state.sessionId)
      await request(`/api/sessions/${state.sessionId}`, method, method === 'PATCH' ? { ended: true } : undefined);
    conversationEpoch++;
    state.sessionId = null;
    clearConversation();
  } catch {
    reportError();
  } finally {
    acceptingWrites = true;
    closing = false;
  }
}

export function newConversation() {
  if (closing)
    return;
  if (!enabled()) {
    conversationEpoch++;
    state.sessionId = null;
    clearConversation();
    return;
  }
  return finishConversation('PATCH');
}

export function deleteConversation() {
  if (!enabled() || !confirm('Удалить этот разговор с диска?'))
    return;
  return finishConversation('DELETE');
}
