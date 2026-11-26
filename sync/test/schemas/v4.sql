-- Schema 4: the shape after step 4 (device cursors), as a household made then has it.
-- The member and device ids are 32 hex characters. The token is the secret '4' x 64.
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
CREATE INDEX record_tombstone ON record(seq) WHERE deleted = 1;
CREATE TABLE device (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL DEFAULT '',
  identity_locked INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
, acked_seq INTEGER NOT NULL DEFAULT 0);
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
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, '2026-11-26 00:00:00');
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, '2026-08-06 00:00:00');
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, '2026-08-06 00:00:00');
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, '2026-11-26 00:00:00');

INSERT INTO device VALUES ('d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 1, 'f435f2420b50c70ec80865cf8e20b169874165fb8576b48633caf2a8176d2e4a', '["family:f4"]', 1000, 1000, 0);
INSERT INTO record VALUES ('txn:c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4:1', 'family:f4', 1, 1000, 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'transaction', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 0, 'n1', 'Y2lwaGVyMQ==');
INSERT INTO record VALUES ('txn:c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4:2', 'family:f4', 2, 2000, 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'transaction', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 0, 'n2', 'Y2lwaGVyMg==');
INSERT INTO record VALUES ('txn:c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4:3', 'family:f4', 3, 3000, 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'transaction', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 1, 'n3', '');
INSERT INTO meta VALUES ('seq', '3');
