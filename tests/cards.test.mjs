import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedule, cardGrades } from '../lib/cards.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { createApp } from '../server.mjs';

const now = '2026-02-01T12:00:00.000Z';
const pair = { source_language: 'es', target_language: 'ru' };
const input = { ...pair, source: 'mesa', meaning: 'стол', example: 'Una mesa.', example_translation: 'Стол.' };
const fresh = { interval_days: 0, ease: 2.5, reps: 0, lapses: 0 };

function api(store) {
  const server = createApp({ store });
  return (path, { method = 'GET', token, input, raw, host = '127.0.0.1:4317', origin } = {}) => {
    const req = Readable.from([Buffer.from(raw ?? (input === undefined ? '' : JSON.stringify(input)))]);
    req.url = path;
    req.method = method;
    req.headers = { host, 'x-session-token': token, ...(origin ? { origin } : {}) };
    return new Promise((resolve, reject) => {
      server.emit('request', req, {
        setHeader() {},
        writeHead(status) { this.status = status; },
        end(value) {
          try {
            resolve({ status: this.status, data: JSON.parse(value) });
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  };
}

test('schedule handles every grade, exact dates and interval labels without mutating the card', () => {
  const expected = {
    again: { interval: 0, ease: 2.3, reps: 0, lapses: 1, due: '2026-02-01T12:10:00.000Z' },
    hard: { interval: 1, ease: 2.35, reps: 1, lapses: 0, due: '2026-02-02T12:00:00.000Z' },
    good: { interval: 1, ease: 2.5, reps: 1, lapses: 0, due: '2026-02-02T12:00:00.000Z' },
    easy: { interval: 1.3, ease: 2.65, reps: 1, lapses: 0, due: '2026-02-02T19:12:00.000Z' }
  };
  for (const grade of cardGrades) {
    const result = schedule(Object.freeze({ ...fresh }), grade, now);
    const item = expected[grade];
    assert.equal(result.interval_days, item.interval);
    assert.equal(result.ease, item.ease);
    assert.equal(result.reps, item.reps);
    assert.equal(result.lapses, item.lapses);
    assert.equal(result.due_at, item.due);
    assert.deepEqual(result.labels, { again: '10 мин', hard: '1 д', good: '1 д', easy: '1 д' });
  }
  assert.throws(() => schedule(fresh, 'unknown', now), RangeError);
  assert.throws(() => schedule(fresh, 'good', 'bad date'), RangeError);
});

test('schedule advances the first two repetitions, multiplies later intervals and restarts after again', () => {
  const second = schedule({ ...fresh, interval_days: 1, reps: 1 }, 'good', now);
  assert.equal(second.interval_days, 3);
  assert.equal(second.reps, 2);
  assert.equal(second.labels.easy, '4 д');
  assert.equal(schedule(second, 'good', now).interval_days, 7.5);
  assert.equal(schedule(second, 'easy', now).interval_days, 9.75);
  assert.equal(schedule({ ...second, interval_days: 10 }, 'hard', now).interval_days, 12);
  const again = schedule({ ...second, lapses: 2 }, 'again', now);
  assert.equal(again.lapses, 3);
  assert.equal(again.reps, 0);
  assert.equal(schedule(again, 'good', now).interval_days, 1);
});

test('schedule clamps ease at both boundaries for every grade', () => {
  for (const grade of cardGrades) {
    for (const ease of [1.3, 3]) {
      const next = schedule({ ...fresh, ease }, grade, now);
      assert.ok(next.ease >= 1.3 && next.ease <= 3);
    }
  }
  assert.equal(schedule({ ...fresh, ease: 1.3 }, 'again', now).ease, 1.3);
  assert.equal(schedule({ ...fresh, ease: 1.3 }, 'hard', now).ease, 1.3);
  assert.equal(schedule({ ...fresh, ease: 3 }, 'easy', now).ease, 3);
});

test('v1 migration preserves conversations and cards survive source deletion and database reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claro-cards-'));
  const path = join(directory, 'cards.sqlite');
  let store;
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'conversation', title TEXT,
        source_language TEXT, target_language TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE turns (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
        seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_language TEXT NOT NULL,
        target_language TEXT NOT NULL, text TEXT NOT NULL, translation TEXT, speaker_id TEXT, glosses TEXT,
        extra TEXT, PRIMARY KEY (session_id, id));
      CREATE INDEX turns_session_seq ON turns(session_id, seq);
      PRAGMA user_version = 1;
    `);
    db.prepare(`INSERT INTO sessions VALUES (?, 'conversation', NULL, 'es', 'ru', ?, ?, NULL)`)
      .run('saved-session', now, now);
    db.prepare(`INSERT INTO turns VALUES (?, 'turn1', 1, ?, ?, 'es', 'ru', ?, ?, NULL, '[]', '{"revision":2}')`)
      .run('saved-session', now, now, input.example, input.example_translation);
    db.close();
    store = new SessionStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    const saved = store.getSession('saved-session');
    assert.equal(saved.turns[0].text, input.example);
    assert.equal(saved.turns[0].translation, input.example_translation);
    assert.equal(saved.turns[0].extra.revision, 2);
    const card = store.createCard({ ...input, session_id: 'saved-session', turn_id: 'turn1' });
    assert.equal(store.db.prepare('PRAGMA foreign_key_list(cards)').all().length, 0);
    assert.ok(store.db.prepare('PRAGMA index_list(cards)').all().some(index => index.name === 'cards_due_at'));
    store.close();
    store = new SessionStore(path);
    assert.equal(store.listCards()[0].id, card.id);
    store.deleteSession('saved-session');
    assert.equal(store.getSession('saved-session'), null);
    store.close();
    store = new SessionStore(path);
    const remaining = store.listCards()[0];
    assert.equal(remaining.id, card.id);
    assert.equal(remaining.example, input.example);
    assert.equal(remaining.example_translation, input.example_translation);
    assert.equal(remaining.session_id, 'saved-session');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('card storage deduplicates words per source language and supports editing, reviews, stats and deletion', () => {
  const store = new SessionStore(':memory:');
  try {
    assert.deepEqual({ ...store.cardStats(now) }, { total: 0, due: 0, next_due_at: null });
    const first = store.createCard(input);
    const duplicate = store.createCard({ ...input, source: ' MESA ', meaning: 'другое', target_language: 'en' });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.meaning, input.meaning);
    const other = store.createCard({ ...input, source_language: 'en' });
    assert.notEqual(first.id, other.id);
    assert.equal(store.listCards({ limit: 1 }).length, 1);
    assert.equal(store.cardStats('2100-01-01').due, 2);
    const edited = store.updateCard(first.id, { source: 'Mesa nueva', meaning: 'Новый стол' });
    assert.equal(edited.example, input.example);
    assert.equal(edited.source, 'Mesa nueva');
    const reviewed = store.reviewCard(first.id, 'good', now);
    assert.equal(reviewed.interval_days, 1);
    assert.equal(reviewed.reps, 1);
    assert.equal(store.listCards({ due: true, now }).length, 0);
    assert.equal(store.cardStats(now).next_due_at, '2026-02-02T12:00:00.000Z');
    assert.equal(store.listCards({ due: true, now: '2026-02-02T12:00:00Z' }).length, 1);
    assert.equal(store.reviewCard('missing', 'good', now), null);
    assert.equal(store.updateCard('missing', { meaning: 'нет' }), null);
    assert.equal(store.deleteCard(first.id), true);
    assert.equal(store.deleteCard(first.id), false);
  } finally {
    store.close();
  }
});

test('cards API protects every route and method with token, Host and Origin checks', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const config = (await request('/api/config')).data;
    assert.equal(config.features.cards, true);
    const card = store.createCard(input);
    for (const [method, path] of [
      ['GET', '/api/cards'], ['POST', '/api/cards'], ['PATCH', `/api/cards/${card.id}`],
      ['DELETE', `/api/cards/${card.id}`], ['POST', `/api/cards/${card.id}/review`]
    ]) {
      assert.equal((await request(path, { method, input })).status, 403);
      assert.equal((await request(path, { method, token: 'wrong', input })).status, 403);
      assert.equal((await request(path, { method, token: config.token, input, origin: 'https://outside.test' })).status, 403);
      assert.equal((await request(path, { method, token: config.token, input, host: 'outside.test' })).status, 403);
    }
  } finally {
    store.close();
  }
});

test('cards API validates payloads, identifiers, languages, grades and list parameters', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const { token } = (await request('/api/config')).data;
    for (const patch of [
      { source: '' }, { source: ' ' }, { source: 12 }, { source: 'x'.repeat(301) },
      { meaning: null }, { meaning: 'x'.repeat(301) }, { source_language: 'unknown' },
      { target_language: '__proto__' }, { example: 'x'.repeat(3001) },
      { example_translation: 'x'.repeat(3001) }, { session_id: {} }, { turn_id: 'x'.repeat(301) }
    ])
      assert.equal((await request('/api/cards', { method: 'POST', token, input: { ...input, ...patch } })).status, 400);
    for (const raw of ['{', '[]', 'null', 'x'.repeat(66000)])
      assert.equal((await request('/api/cards', { method: 'POST', token, raw })).status, 400);
    for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=Infinity', 'due=yes'])
      assert.equal((await request(`/api/cards?${query}`, { token })).status, 400);
    assert.equal((await request('/api/cards/bad', { method: 'DELETE', token })).status, 400);
    const card = store.createCard(input);
    for (const grade of ['bad', null, 1])
      assert.equal((await request(`/api/cards/${card.id}/review`, { method: 'POST', token, input: { grade } })).status, 400);
    for (const value of [{}, { source: null }, { meaning: '' }, { source: 'x'.repeat(301) }])
      assert.equal((await request(`/api/cards/${card.id}`, { method: 'PATCH', token, input: value })).status, 400);
    const other = store.createCard({ ...input, source: 'otra' });
    assert.equal((await request(`/api/cards/${other.id}`, { method: 'PATCH', token, input: { source: 'MESA' } })).status, 400);
    assert.equal(store.listCards().find(item => item.id === other.id).source, 'otra');
  } finally {
    store.close();
  }
});

test('cards API completes create, duplicate, list, edit, all review grades and delete', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const { token } = (await request('/api/config')).data;
    const created = await request('/api/cards', { method: 'POST', token, input });
    assert.equal(created.status, 200);
    const card = created.data;
    assert.equal(card.example, input.example);
    assert.equal(card.review_labels.again, '10 мин');
    const duplicate = await request('/api/cards', { method: 'POST', token, input: { ...input, source: 'MESA' } });
    assert.equal(duplicate.data.id, card.id);
    const listed = await request('/api/cards?due=1&limit=100', { token });
    assert.equal(listed.data.stats.total, 1);
    assert.equal(listed.data.stats.due, 1);
    assert.equal(listed.data.cards.length, 1);
    const edited = await request(`/api/cards/${card.id}`, { method: 'PATCH', token, input: { meaning: 'столик' } });
    assert.equal(edited.data.meaning, 'столик');
    for (const grade of cardGrades) {
      const result = await request(`/api/cards/${card.id}/review`, { method: 'POST', token, input: { grade } });
      assert.equal(result.status, 200);
      assert.ok(Date.parse(result.data.due_at) > Date.now());
      assert.ok(result.data.review_labels.good);
    }
    const finished = await request('/api/cards?due=1', { token });
    assert.equal(finished.data.cards.length, 0);
    assert.equal(finished.data.stats.due, 0);
    assert.ok(finished.data.stats.next_due_at);
    assert.equal((await request(`/api/cards/${card.id}`, { method: 'DELETE', token })).data.ok, true);
    for (const [method, suffix, value] of [['DELETE', '', undefined], ['PATCH', '', { meaning: 'нет' }], ['POST', '/review', { grade: 'good' }]])
      assert.equal((await request(`/api/cards/${card.id}${suffix}`, { method, token, input: value })).status, 404);
  } finally {
    store.close();
  }
});

test('cards are unavailable without storage and database errors never expose stored text', async () => {
  const request = api(null);
  assert.equal((await request('/api/config')).data.features.cards, false);
  assert.equal((await request('/api/cards')).status, 404);
  const broken = api({ listCards() { throw new Error(input.example); } });
  const { token } = (await broken('/api/config')).data;
  const result = await broken('/api/cards', { token });
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.data), /Una mesa/);
});
