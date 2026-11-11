import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../lib/sessions.mjs';
import { createApp } from '../server.mjs';

const pair = { source_language: 'es', target_language: 'ru' };
const turn = (id = 'turn_1') => ({
  id, ...pair, text: 'Una mesa.', created_at: '2026-01-01T12:00:00.000Z',
  translation: 'Стол.', translation_status: 'ready',
  glosses: [{ index: 0, source: 'Una', meaning: 'один', start: 0, end: 3 }],
  gloss_status: 'ready', speaker_id: 'self',
  speaker_assignment: { origin: 'manual', confirmed: true, confidence: 1 },
  source_record: { id: 'source_1', text: 'Una mesa.', revision: 2, start: 0, end: 9 },
  engine: 'qwen', input: 'text', revision: 2
});

// Dispatch through the server's request handler without binding a network port.
function api(store) {
  const server = createApp({ store });
  async function request(path, { method = 'GET', token, input, raw, origin, host } = {}) {
    const encoded = raw ?? (input === undefined ? '' : JSON.stringify(input));
    const req = Readable.from([Buffer.from(encoded)]);
    req.url = path;
    req.method = method;
    req.headers = { host: host || '127.0.0.1:4317' };
    if (token !== undefined)
      req.headers['x-session-token'] = token;
    if (origin)
      req.headers.origin = origin;
    return new Promise((resolve, reject) => {
      const headers = {};
      const res = {
        headersSent: false,
        setHeader(name, value) { headers[name] = value; },
        writeHead(status, values) {
          this.status = status;
          this.headersSent = true;
          Object.assign(headers, values);
        },
        end(data) {
          try {
            resolve({ status: this.status, data: JSON.parse(data), headers });
          } catch (error) {
            reject(error);
          }
        }
      };
      server.emit('request', req, res);
    });
  }
  return request;
}

test('session store migrates an empty database and enables foreign keys', () => {
  const store = new SessionStore(':memory:');
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(store.listSessions(), []);
    assert.equal(store.latestActive(120), null);
    assert.throws(() => store.upsertTurn(randomUUID(), turn()));
  } finally {
    store.close();
  }
});

test('session store CRUD preserves insertion sequence, metadata and cascades deletion', () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.createSession(pair);
    assert.equal(session.kind, 'conversation');
    assert.equal(store.upsertTurn(session.id, turn('second_name')), 1);
    assert.equal(store.upsertTurn(session.id, turn('first_name')), 2);
    assert.equal(store.upsertTurn(session.id, { ...turn('second_name'), text: 'Otra mesa.' }), 1);
    const saved = store.getSession(session.id);
    assert.deepEqual(saved.turns.map(item => item.id), ['second_name', 'first_name']);
    assert.equal(saved.turns[0].text, 'Otra mesa.');
    assert.equal(saved.turns[0].translation, 'Стол.');
    assert.equal(saved.turns[0].speaker_id, 'self');
    assert.deepEqual(saved.turns[0].glosses, turn().glosses);
    assert.deepEqual(saved.turns[0].extra.source_record, turn().source_record);
    assert.equal(saved.turns[0].extra.revision, 2);
    assert.equal(store.listSessions({ limit: 1 })[0].turn_count, 2);
    assert.equal(store.listSessions()[0].preview, 'Otra mesa.');
    assert.equal(store.updateSession(session.id, { title: 'Учебный разговор' }).title, 'Учебный разговор');
    assert.equal(store.latestActive(120).session.id, session.id);
    assert.ok(store.updateSession(session.id, { ended: true }).ended_at);
    assert.equal(store.latestActive(120), null);
    assert.equal(store.deleteSession(session.id), true);
    assert.equal(store.getSession(session.id), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM turns').get().count, 0);
    assert.equal(store.deleteSession(session.id), false);
  } finally {
    store.close();
  }
});

test('session store closes prior sessions, orders newest first and ignores idle sessions', () => {
  const store = new SessionStore(':memory:');
  try {
    const first = store.createSession(pair);
    const second = store.createSession({ ...pair, kind: 'watch' });
    assert.ok(store.getSession(first.id).session.ended_at);
    assert.deepEqual(store.listSessions().map(session => session.id), [second.id, first.id]);
    assert.equal(store.latestActive(120).session.id, second.id);
    store.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', second.id);
    assert.equal(store.latestActive(120), null);
    store.upsertTurn(second.id, turn());
    assert.equal(store.latestActive(120).session.id, second.id);
  } finally {
    store.close();
  }
});

test('session store survives reopening a file with WAL and preserves the schema version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claro-sessions-'));
  let store;
  try {
    const path = join(directory, 'claro.sqlite');
    store = new SessionStore(path);
    const session = store.createSession(pair);
    store.upsertTurn(session.id, turn());
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    store.close();
    store = new SessionStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(store.getSession(session.id).turns[0].text, turn().text);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session API protects every method and private GET with token, Host and Origin checks', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const config = (await request('/api/config')).data;
    assert.equal(config.features.sessions, true);
    assert.deepEqual(config.storage, { enabled: true });
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/active'], ['GET', `/api/sessions/${id}`],
      ['POST', '/api/sessions'], ['PUT', `/api/sessions/${id}/turns/turn_1`],
      ['PATCH', `/api/sessions/${id}`], ['DELETE', `/api/sessions/${id}`]
    ]) {
      assert.equal((await request(path, { method })).status, 403);
      assert.equal((await request(path, { method, token: 'wrong' })).status, 403);
    }
    assert.equal((await request('/api/sessions', { token: config.token, origin: 'https://example.com' })).status, 403);
    assert.equal((await request('/api/sessions', { token: config.token, host: 'example.com' })).status, 403);
  } finally {
    store.close();
  }
});

test('session API completes create, upsert, list, restore, end and delete', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const { token } = (await request('/api/config')).data;
    const created = await request('/api/sessions', { method: 'POST', token, input: pair });
    assert.equal(created.status, 200);
    const path = `/api/sessions/${created.data.id}`;
    assert.deepEqual((await request(`${path}/turns/one`, { method: 'PUT', token, input: turn() })).data, { ok: true, seq: 1 });
    assert.deepEqual((await request(`${path}/turns/two`, { method: 'PUT', token, input: turn() })).data, { ok: true, seq: 2 });
    assert.equal((await request(`${path}/turns/one`, { method: 'PUT', token, input: { ...turn(), translation: 'Другой стол.' } })).data.seq, 1);
    const saved = (await request(path, { token })).data;
    assert.deepEqual(saved.turns.map(item => item.id), ['one', 'two']);
    assert.equal(saved.turns[0].translation, 'Другой стол.');
    assert.equal(saved.turns[0].extra.speaker_assignment.origin, 'manual');
    assert.equal((await request('/api/sessions?limit=1', { token })).data.sessions[0].turn_count, 2);
    assert.equal((await request('/api/sessions/active', { token })).data.session.id, created.data.id);
    assert.equal((await request(path, { method: 'PATCH', token, input: { title: 'Учебная фраза', ended: true } })).data.title, 'Учебная фраза');
    assert.deepEqual((await request('/api/sessions/active', { token })).data, { session: null });
    assert.equal((await request(path, { method: 'DELETE', token })).status, 200);
    assert.equal((await request(path, { token })).status, 404);
    const first = (await request('/api/sessions', { method: 'POST', token, input: pair })).data;
    await request('/api/sessions', { method: 'POST', token, input: { ...pair, kind: 'watch' } });
    assert.ok((await request(`/api/sessions/${first.id}`, { token })).data.session.ended_at);
  } finally {
    store.close();
  }
});

test('session API validates identifiers, payload limits, languages and missing sessions', async () => {
  const store = new SessionStore(':memory:');
  try {
    const request = api(store);
    const { token } = (await request('/api/config')).data;
    for (const input of [null, [], {}, { ...pair, kind: 'other' }, { ...pair, source_language: 'xx' }])
      assert.equal((await request('/api/sessions', { method: 'POST', token, input })).status, 400);
    assert.equal((await request('/api/sessions', { method: 'POST', token, raw: '{' })).status, 400);
    const session = store.createSession(pair);
    const path = `/api/sessions/${session.id}`;
    for (const input of [
      { ...turn(), text: '' }, { ...turn(), text: ' ' }, { ...turn(), text: 'a'.repeat(3001) },
      { ...turn(), translation: 'a'.repeat(4001) }, { ...turn(), translation: 1 },
      { ...turn(), source_language: 'xx' }, { ...turn(), target_language: 'xx' },
      { ...turn(), created_at: 'invalid' }, { ...turn(), glosses: {} },
      { ...turn(), glosses: Array(301).fill(turn().glosses[0]) },
      { ...turn(), glosses: [{ ...turn().glosses[0], meaning: 'a'.repeat(301) }] },
      { ...turn(), glosses: [{ ...turn().glosses[0], source: 'a'.repeat(301) }] },
      { ...turn(), glosses: [{ ...turn().glosses[0], index: -1 }] },
      { ...turn(), glosses: [null] }
    ])
      assert.equal((await request(`${path}/turns/valid`, { method: 'PUT', token, input })).status, 400);
    assert.equal((await request(`${path}/turns/valid`, { method: 'PUT', token, input: { ...turn(), source_record: { text: 'a'.repeat(65536) } } })).status, 400);
    for (const id of ['bad.id', 'a'.repeat(101)])
      assert.equal((await request(`${path}/turns/${id}`, { method: 'PUT', token, input: turn() })).status, 400);
    assert.equal((await request('/api/sessions/not-uuid', { token })).status, 400);
    for (const suffix of ['0', '-1', 'abc', '1.5'])
      assert.equal((await request(`/api/sessions?limit=${suffix}`, { token })).status, 400);
    const missing = `/api/sessions/${randomUUID()}`;
    for (const method of ['GET', 'PATCH', 'DELETE'])
      assert.equal((await request(missing, { method, token, input: {} })).status, 404);
    assert.equal((await request(`${missing}/turns/valid`, { method: 'PUT', token, input: turn() })).status, 404);
    assert.equal((await request(path, { method: 'PATCH', token, input: { ended: false } })).status, 400);
    assert.equal((await request(path, { method: 'PATCH', token, input: { title: 2 } })).status, 400);
    assert.equal((await request(path, { method: 'POST', token })).status, 404);
    assert.equal((await request(`${path}/turns/valid`, { method: 'GET', token })).status, 404);
  } finally {
    store.close();
  }
});

test('session API returns 404 without a store and isolates database failures', async () => {
  const disabled = api();
  const { token } = (await disabled('/api/config')).data;
  assert.equal((await disabled('/api/config')).data.features.sessions, false);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal((await disabled('/api/sessions', { method, token })).status, 404);
  const request = api({ listSessions() { throw new Error('private database details'); } });
  const config = (await request('/api/config')).data;
  const result = await request('/api/sessions', { token: config.token });
  assert.equal(result.status, 500);
  assert.equal(result.data.error, 'Не удалось обратиться к хранилищу разговоров.');
  assert.equal((await request('/api/config')).status, 200);
});
