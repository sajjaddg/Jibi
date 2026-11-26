-- Schema 2: `record` has its three columns and the migrations table exists with step 2 taken,
-- but `device` is still the old shape. The token is the secret '2' x 64.
CREATE TABLE record (
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
CREATE INDEX record_seq ON record(seq);
CREATE TABLE device (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE TABLE pairing (
  code_hash  TEXT PRIMARY KEY,
  scopes     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE _sql_schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, '2026-08-01 00:00:00');

INSERT INTO device VALUES ('d2', '4f2e8d65483c641648cdb374ae9d8abd368d269e4ddffe092a8237b8162cddd6', '["family:f2"]', 1000, 5000);
INSERT INTO record VALUES ('txn:b:1', 'family:f2', 1, 1000, 'd2', 'transaction', 'b', 'b', 0, 'n1', 'Y2lwaGVyMQ==');
INSERT INTO record VALUES ('txn:b:2', 'family:f2', 2, 2000, 'd2', 'transaction', 'b', 'b', 0, 'n2', 'Y2lwaGVyMg==');
INSERT INTO record VALUES ('txn:b:3', 'family:f2', 3, 3000, 'd2', 'transaction', 'b', 'b', 1, 'n3', '');
INSERT INTO meta VALUES ('seq', '3');
