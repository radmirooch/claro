import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { schedule } from './cards.mjs';

const extraFields = [
  'translation_status', 'gloss_status', 'speaker_assignment',
  'source_record', 'engine', 'input', 'revision'
];

export class SessionStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    try {
      this.db.prepare('PRAGMA journal_mode = WAL').get();
      this.db.prepare('PRAGMA foreign_keys = ON').run();
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2)
        throw new Error('Версия хранилища разговоров не поддерживается.');
      if (version === 0) {
        this.transaction(() => {
          this.db.prepare(`CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'conversation',
            title TEXT,
            source_language TEXT,
            target_language TEXT,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            ended_at TEXT
          )`).run();
          this.db.prepare(`CREATE TABLE turns (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source_language TEXT NOT NULL,
            target_language TEXT NOT NULL,
            text TEXT NOT NULL,
            translation TEXT,
            speaker_id TEXT,
            glosses TEXT,
            extra TEXT,
            PRIMARY KEY (session_id, id)
          )`).run();
          this.db.prepare('CREATE INDEX turns_session_seq ON turns(session_id, seq)').run();
          this.db.prepare('PRAGMA user_version = 1').run();
        });
      }
      if (version < 2) {
        this.transaction(() => {
          this.db.prepare(`CREATE TABLE cards (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            meaning TEXT NOT NULL,
            source_language TEXT NOT NULL,
            target_language TEXT NOT NULL,
            example TEXT,
            example_translation TEXT,
            session_id TEXT,
            turn_id TEXT,
            created_at TEXT NOT NULL,
            due_at TEXT NOT NULL,
            interval_days REAL NOT NULL DEFAULT 0,
            ease REAL NOT NULL DEFAULT 2.5,
            reps INTEGER NOT NULL DEFAULT 0,
            lapses INTEGER NOT NULL DEFAULT 0
          )`).run();
          this.db.prepare('CREATE INDEX cards_due_at ON cards(due_at)').run();
          this.db.prepare('CREATE UNIQUE INDEX cards_source ON cards(source_language, lower(source))').run();
          this.db.prepare('PRAGMA user_version = 2').run();
        });
      }
      this.statements = {
        endActive: this.db.prepare('UPDATE sessions SET ended_at = ?, updated_at = ? WHERE ended_at IS NULL'),
        create: this.db.prepare(`INSERT INTO sessions
          (id, kind, source_language, target_language, started_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`),
        list: this.db.prepare(`SELECT sessions.*,
          (SELECT COUNT(*) FROM turns WHERE session_id = sessions.id) AS turn_count,
          (SELECT text FROM turns WHERE session_id = sessions.id ORDER BY seq LIMIT 1) AS preview
          FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?`),
        session: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
        turns: this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY seq'),
        upsert: this.db.prepare(`INSERT INTO turns
          (session_id, id, seq, created_at, updated_at, source_language,
           target_language, text, translation, speaker_id, glosses, extra)
          VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM turns WHERE session_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET
            updated_at = excluded.updated_at,
            source_language = excluded.source_language,
            target_language = excluded.target_language,
            text = excluded.text,
            translation = excluded.translation,
            speaker_id = excluded.speaker_id,
            glosses = excluded.glosses,
            extra = excluded.extra
          RETURNING seq`),
        touch: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
        update: this.db.prepare(`UPDATE sessions SET
          title = CASE WHEN ? THEN ? ELSE title END,
          ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
          updated_at = ? WHERE id = ?`),
        delete: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
        active: this.db.prepare(`SELECT id FROM sessions
          WHERE ended_at IS NULL AND updated_at >= ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      };
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(action) {
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = action();
      this.db.prepare('COMMIT').run();
      return result;
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }
  }

  createSession({ kind = 'conversation', source_language, target_language }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      this.statements.endActive.run(now, now);
      this.statements.create.run(id, kind, source_language, target_language, now, now);
      return this.statements.session.get(id);
    });
  }

  listSessions({ limit = 50 } = {}) {
    return this.statements.list.all(limit);
  }

  hasSession(id) {
    return Boolean(this.statements.session.get(id));
  }

  getSession(id) {
    const session = this.statements.session.get(id);
    if (!session)
      return null;
    const turns = this.statements.turns.all(id).map(turn => ({
      ...turn,
      glosses: turn.glosses === null ? null : JSON.parse(turn.glosses),
      extra: turn.extra === null ? {} : JSON.parse(turn.extra)
    }));
    return { session, turns };
  }

  upsertTurn(sessionId, turn) {
    const now = new Date().toISOString();
    const extra = Object.fromEntries(extraFields
      .filter(key => turn[key] !== undefined)
      .map(key => [key, turn[key]]));
    return this.transaction(() => {
      const { seq } = this.statements.upsert.get(
        sessionId, turn.id, sessionId, turn.created_at, now,
        turn.source_language, turn.target_language, turn.text,
        turn.translation ?? null, turn.speaker_id ?? null,
        turn.glosses == null ? null : JSON.stringify(turn.glosses), JSON.stringify(extra)
      );
      this.statements.touch.run(now, sessionId);
      return seq;
    });
  }

  updateSession(id, { title, ended } = {}) {
    const now = new Date().toISOString();
    this.statements.update.run(Number(title !== undefined), title ?? null, Number(ended === true), now, now, id);
    return this.statements.session.get(id) ?? null;
  }

  deleteSession(id) {
    return this.statements.delete.run(id).changes > 0;
  }

  createCard(input) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO cards
      (id, source, meaning, source_language, target_language, example,
       example_translation, session_id, turn_id, created_at, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_language, lower(source)) DO NOTHING`).run(
      randomUUID(), input.source.trim(), input.meaning.trim(), input.source_language,
      input.target_language, input.example ?? null, input.example_translation ?? null,
      input.session_id ?? null, input.turn_id ?? null, now, now
    );
    return this.db.prepare('SELECT * FROM cards WHERE source_language = ? AND lower(source) = lower(?)')
      .get(input.source_language, input.source.trim());
  }

  listCards({ due = false, limit = 50, now = new Date() } = {}) {
    const time = new Date(now).toISOString();
    return this.db.prepare(`SELECT * FROM cards WHERE (? = 0 OR due_at <= ?)
      ORDER BY due_at, created_at, id LIMIT ?`).all(Number(due), time, limit);
  }

  reviewCard(id, grade, now = new Date()) {
    return this.transaction(() => {
      const card = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
      if (!card)
        return null;
      const next = schedule(card, grade, now);
      this.db.prepare(`UPDATE cards SET due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ?
        WHERE id = ?`).run(next.due_at, next.interval_days, next.ease, next.reps, next.lapses, id);
      return this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    });
  }

  updateCard(id, { source, meaning } = {}) {
    this.db.prepare(`UPDATE cards SET source = COALESCE(?, source), meaning = COALESCE(?, meaning)
      WHERE id = ?`).run(source?.trim() ?? null, meaning?.trim() ?? null, id);
    return this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) ?? null;
  }

  deleteCard(id) {
    return this.db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0;
  }

  cardStats(now = new Date()) {
    const time = new Date(now).toISOString();
    return this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(due_at <= ?), 0) AS due,
      MIN(CASE WHEN due_at > ? THEN due_at END) AS next_due_at FROM cards`).get(time, time);
  }

  latestActive(maxIdleMinutes) {
    const since = new Date(Date.now() - maxIdleMinutes * 60000).toISOString();
    const active = this.statements.active.get(since);
    return active ? this.getSession(active.id) : null;
  }

  close() {
    this.db.close();
  }
}
