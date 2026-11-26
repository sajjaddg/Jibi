-- Schema 1: a household made before `record` knew kind / owner_member / author_member and before
-- `device` knew member_id / identity_locked, and before `_sql_schema_migrations` existed. Rebuilt
-- from the ALTER branches the first migrate() carried, which exist to upgrade exactly this.
-- The token is the secret '1' x 64.
CREATE TABLE record (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device     TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  nonce      TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX record_seq ON record(seq);
CREATE INDEX record_scope_seq ON record(scope, seq);
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

INSERT INTO device VALUES ('d1', '3138bb9bc78df27c473ecfd1410f7bd45ebac1f59cf3ff9cfe4db77aab7aedd3', '["family:f1"]', 1000, 5000);
INSERT INTO record VALUES ('txn:a:1', 'family:f1', 1, 1000, 'd1', 0, 'n1', 'Y2lwaGVyMQ==');
INSERT INTO record VALUES ('txn:a:2', 'family:f1', 2, 2000, 'd1', 0, 'n2', 'Y2lwaGVyMg==');
INSERT INTO record VALUES ('txn:a:3', 'family:f1', 3, 3000, 'd1', 1, 'n3', '');
INSERT INTO meta VALUES ('seq', '3');
