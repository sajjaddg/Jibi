/**
 * The Household object's schema, as numbered steps.
 *
 * Every household is its own SQLite database that wakes whenever it is addressed, so a Worker
 * deploy cannot migrate them in one go: each object finds out which steps it has not taken the
 * next time somebody talks to it, and a household nobody has opened since the last deploy may
 * be several steps behind. That is why a step here is never edited after it ships and never
 * clever: it is the one place where a mistake rewrites a family's ledger for good, and the
 * ledger is ciphertext no rescan can rebuild — the same position `durable.db` is in on the
 * phone (AGENTS.md: hand-written, tested migrations only, nothing destructive).
 *
 * The rules, each of which `test/migrations.test.ts` holds:
 *  - ids are 1, 2, 3 … with no gaps, and a step is recorded in `_sql_schema_migrations` in the
 *    same transaction that runs it, so it is taken once or not at all;
 *  - a step only adds. Nothing drops, renames or empties `record`, and no step deletes rows;
 *  - an object that knows steps this Worker does not (a deploy was rolled back) is left alone:
 *    additive steps cannot have broken the older code.
 */

export interface Migration {
  id: number;
  /** What it does, for whoever reads a failing test. */
  name: string;
  up(sql: SqlStorage): void;
}

function columnsOf(sql: SqlStorage, table: string): Set<string> {
  return new Set([...sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)].map((row) => row.name));
}

/**
 * Steps 1 to 3 are what `migrate()` did before it was numbered, expressed the way it did them
 * and nothing more: tables created if missing, columns added if missing. Production objects
 * already carry rows for 2 and 3 and never run them again; the objects an older Worker made,
 * before either column existed, take them now. All three stay safe to repeat, because an
 * object that predates `_sql_schema_migrations` has the columns and no row saying so.
 *
 * Which of the two ALTER groups was 2 and which was 3 is inferred from the order they were
 * written in; nothing recorded it. What matters is that the ids already in production stay.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'the four tables, as a fresh household has them',
    up(sql) {
      // A fresh household gets its columns here; one made by an older Worker already has these
      // tables, and steps 2 and 3 bring them up to date.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS record (
          id         TEXT PRIMARY KEY,
          scope      TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          device     TEXT NOT NULL,
          kind       TEXT NOT NULL DEFAULT 'legacy',
          owner_member TEXT NOT NULL DEFAULT '',
          author_member TEXT NOT NULL DEFAULT '',
          deleted    INTEGER NOT NULL DEFAULT 0,
          nonce      TEXT NOT NULL,
          body       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS record_seq ON record(seq);
        DROP INDEX IF EXISTS record_scope_seq;

        CREATE TABLE IF NOT EXISTS device (
          id         TEXT PRIMARY KEY,
          member_id  TEXT NOT NULL DEFAULT '',
          identity_locked INTEGER NOT NULL DEFAULT 1,
          token_hash TEXT NOT NULL,
          scopes     TEXT NOT NULL,
          added_at   INTEGER NOT NULL,
          last_seen  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pairing (
          code_hash  TEXT PRIMARY KEY,
          scopes     TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
    },
  },
  {
    id: 2,
    name: 'record gains kind, owner_member and author_member',
    up(sql) {
      const columns = columnsOf(sql, 'record');
      if (!columns.has('kind')) sql.exec("ALTER TABLE record ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'");
      if (!columns.has('owner_member')) sql.exec("ALTER TABLE record ADD COLUMN owner_member TEXT NOT NULL DEFAULT ''");
      if (!columns.has('author_member')) sql.exec("ALTER TABLE record ADD COLUMN author_member TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: 3,
    name: 'device gains member_id and identity_locked',
    up(sql) {
      const columns = columnsOf(sql, 'device');
      if (!columns.has('member_id')) sql.exec("ALTER TABLE device ADD COLUMN member_id TEXT NOT NULL DEFAULT ''");
      // Existing tokens predate explicit person/device identity. They get exactly one upgrade.
      if (!columns.has('identity_locked')) {
        sql.exec('ALTER TABLE device ADD COLUMN identity_locked INTEGER NOT NULL DEFAULT 0');
      }
    },
  },
];

/**
 * Takes every step this object has not taken, in order, each in its own transaction with the
 * row that records it. Returns the ids it took.
 */
export function runMigrations(storage: DurableObjectStorage, steps: Migration[] = MIGRATIONS): number[] {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const done = new Set([...sql.exec<{ id: number }>('SELECT id FROM _sql_schema_migrations')].map((row) => row.id));
  const took: number[] = [];
  for (const step of steps) {
    if (done.has(step.id)) continue;
    storage.transactionSync(() => {
      step.up(sql);
      sql.exec('INSERT INTO _sql_schema_migrations (id) VALUES (?)', step.id);
    });
    took.push(step.id);
  }
  return took;
}
