import { DatabaseSync, type SQLInputValue } from "node:sqlite"

/*
  One SQLite file holds every lab. Content (questions, cards, topics, lectures) and progress
  (SRS records, notes, the event log) are rows keyed by lab, so a lab can be exported, reset or
  deleted on its own, and the coach can query across them with plain SQL.
*/

const MIGRATIONS: string[] = [
  `
  CREATE TABLE labs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    description TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened_at INTEGER NOT NULL DEFAULT 0,
    built_at TEXT NOT NULL DEFAULT '',
    conflicts TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE topics (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    d INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (lab_id, id)
  );

  CREATE TABLE questions (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    src TEXT NOT NULL,
    src_name TEXT NOT NULL DEFAULT '',
    set_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'quiz',
    n INTEGER NOT NULL DEFAULT 0,
    d INTEGER NOT NULL DEFAULT 1,
    stem TEXT NOT NULL,
    opts TEXT NOT NULL,
    ans TEXT NOT NULL,
    why TEXT NOT NULL,
    explanation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lab_id, id)
  );

  CREATE TABLE question_topics (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    qid TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lab_id, qid, topic_id)
  );

  CREATE TABLE cards (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    topic_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    x TEXT,
    src TEXT NOT NULL DEFAULT 'L',
    status TEXT NOT NULL DEFAULT 'active',
    created INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lab_id, id)
  );

  CREATE TABLE lectures (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    title TEXT NOT NULL,
    sec TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    PRIMARY KEY (lab_id, n)
  );

  CREATE VIRTUAL TABLE lectures_fts USING fts5(lab_id UNINDEXED, n UNINDEXED, title, body, tokenize = 'porter unicode61');

  CREATE TABLE srs (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rec TEXT NOT NULL,
    PRIMARY KEY (lab_id, kind, item_id)
  );

  CREATE TABLE notes (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (lab_id, key)
  );

  CREATE TABLE lab_meta (
    lab_id TEXT PRIMARY KEY REFERENCES labs(id) ON DELETE CASCADE,
    meta TEXT NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    correct INTEGER NOT NULL,
    grade INTEGER NOT NULL,
    conf INTEGER,
    picks TEXT,
    first TEXT,
    ms INTEGER NOT NULL,
    changes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_lab_at ON events(lab_id, at);
  CREATE INDEX events_lab_item ON events(lab_id, item_id);

  CREATE TABLE insights (
    id TEXT PRIMARY KEY,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    data TEXT NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tools TEXT,
    raw TEXT
  );

  CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    undo TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE ai_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    lab_id TEXT,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: where content came from (content packages)
  `
  CREATE TABLE sources (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    language TEXT,
    lecture_base INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (lab_id, id)
  );
  ALTER TABLE lectures ADD COLUMN source_id TEXT;
  ALTER TABLE lectures ADD COLUMN kind TEXT NOT NULL DEFAULT 'lecture';
  ALTER TABLE questions ADD COLUMN source_id TEXT;
  `,
  // v3: knowledge graph (chunks with evidence, knowledge components, typed edges, Q-matrix)
  `
  CREATE TABLE chunks (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    lecture_n INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB,
    PRIMARY KEY (lab_id, id)
  );
  CREATE INDEX chunks_lecture ON chunks(lab_id, lecture_n, ord);

  CREATE TABLE kcs (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    topic_id TEXT,
    name TEXT NOT NULL,
    definition TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'concept',
    status TEXT NOT NULL DEFAULT 'active',
    merged_into TEXT,
    first_lecture INTEGER,
    evidence TEXT NOT NULL DEFAULT '[]',
    embedding BLOB,
    created INTEGER NOT NULL,
    PRIMARY KEY (lab_id, id)
  );

  CREATE TABLE edges (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    method TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'accepted',
    created INTEGER NOT NULL,
    PRIMARY KEY (lab_id, src, dst, type)
  );

  CREATE TABLE item_kc (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kc_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary',
    conf REAL NOT NULL DEFAULT 1,
    method TEXT NOT NULL DEFAULT 'llm',
    verified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lab_id, item_kind, item_id, kc_id)
  );
  CREATE INDEX item_kc_kc ON item_kc(lab_id, kc_id);

  CREATE TABLE option_kc (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    qid TEXT NOT NULL,
    option INTEGER NOT NULL,
    kc_id TEXT NOT NULL,
    PRIMARY KEY (lab_id, qid, option)
  );
  `,
  // v4: knowledge-base build checkpoints, so a failed build resumes without paying for extraction again
  `
  CREATE TABLE kb_cache (
    lab_id TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (lab_id, key)
  );
  `,
]

let db: DatabaseSync | null = null

export function openDb(file: string): DatabaseSync {
  db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(() => {
      db!.exec(MIGRATIONS[v])
      db!.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
  return db
}

export function closeDb() {
  db?.close()
  db = null
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database is not open")
  return db
}

let depth = 0
/** Run fn in a transaction. Nested calls join the outer one. */
export function tx<T>(fn: () => T): T {
  const d = getDb()
  if (depth > 0) return fn()
  depth++
  d.exec("BEGIN")
  try {
    const out = fn()
    d.exec("COMMIT")
    return out
  } catch (e) {
    d.exec("ROLLBACK")
    throw e
  } finally {
    depth--
  }
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[]
}

export function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return getDb().prepare(sql).run(...params)
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(key: string, value: unknown) {
  run("INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value))
}
