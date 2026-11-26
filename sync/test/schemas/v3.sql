-- Schema 3: production on 2026-11-26 — the shape a fresh household gets, with steps 2 and 3
-- recorded and no step 1 (the framework numbers it later, and it only creates what exists).
-- The member and device ids are 32 hex characters. The token is the secret '3' x 64.
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
  member_id  TEXT NOT NULL DEFAULT '',
  identity_locked INTEGER NOT NULL DEFAULT 1,
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
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, '2026-08-06 00:00:00');
INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, '2026-08-06 00:00:00');

INSERT INTO device VALUES ('d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 1, '79bd7d7fd684b399857c582b1b7172ddf277d4fe1b027ec52b28da3ae381e675', '["family:f3"]', 1000, 1000);
INSERT INTO record VALUES ('txn:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3:1', 'family:f3', 1, 1000, 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3', 'transaction', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 0, 'n1', 'Y2lwaGVyMQ==');
INSERT INTO record VALUES ('txn:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3:2', 'family:f3', 2, 2000, 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3', 'transaction', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 0, 'n2', 'Y2lwaGVyMg==');
INSERT INTO record VALUES ('txn:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3:3', 'family:f3', 3, 3000, 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3', 'transaction', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 1, 'n3', '');
INSERT INTO meta VALUES ('seq', '3');
