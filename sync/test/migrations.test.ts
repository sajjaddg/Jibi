import { abortAllDurableObjects, env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations, type Migration } from '../src/migrations';
import v1 from './schemas/v1.sql?raw';
import v2 from './schemas/v2.sql?raw';
import v3 from './schemas/v3.sql?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Every schema a household has ever had, opened by the real object through the real wake-up
 * (the constructor sees a `device` table and migrates before anything else is answered), then
 * read back over HTTP. The fixtures in test/schemas are dumps of what each version left behind;
 * the point is that no matter how far behind a household that nobody opened for months is, the
 * ledger in it comes out whole.
 */

const FIXTURES = [
  { name: 'schema 1', sql: v1, secret: '1'.repeat(64), scope: 'family:f1', ids: ['txn:a:1', 'txn:a:2', 'txn:a:3'], locked: 0 },
  { name: 'schema 2', sql: v2, secret: '2'.repeat(64), scope: 'family:f2', ids: ['txn:b:1', 'txn:b:2', 'txn:b:3'], locked: 0 },
  {
    name: 'schema 3',
    sql: v3,
    secret: '3'.repeat(64),
    scope: 'family:f3',
    ids: ['c3'.repeat(16)].flatMap((m) => [1, 2, 3].map((n) => `txn:${m}:${n}`)),
    locked: 1,
  },
];

const RECORD_COLUMNS = [
  'author_member', 'body', 'deleted', 'device', 'id', 'kind', 'nonce', 'owner_member', 'scope', 'seq', 'updated_at',
];
const DEVICE_COLUMNS = ['added_at', 'id', 'identity_locked', 'last_seen', 'member_id', 'scopes', 'token_hash'];

let next = 0;
/** A household id nobody has used: the object comes into being by being addressed. */
function freshHid(): string {
  next += 1;
  return `ee${next.toString(16).padStart(2, '0')}`.repeat(8);
}

/** Writes a fixture into an object that has no tables yet, then wakes it again as production would. */
async function seed(hid: string, fixture: string) {
  await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => {
    state.storage.sql.exec(fixture);
  });
  await abortAllDurableObjects();
}

async function inside<T>(hid: string, read: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => read(state.storage.sql));
}

function columns(sql: SqlStorage, table: string): string[] {
  return [...sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)].map((row) => row.name).sort();
}

function taken(sql: SqlStorage): { id: number; applied_at: string }[] {
  return [...sql.exec<{ id: number; applied_at: string }>('SELECT id, applied_at FROM _sql_schema_migrations ORDER BY id')];
}

async function pullAll(hid: string, secret: string) {
  const res = await SELF.fetch('https://sync.test/v1/sync?since=0', { headers: { authorization: `Bearer ${hid}.${secret}` } });
  return { status: res.status, json: (await res.json()) as { seq: number; records: { id: string; deleted: boolean; body: string }[] } };
}

describe('the numbered steps', () => {
  it('are 1, 2, 3 … with no gap and no repeat', () => {
    expect(MIGRATIONS.map((step) => step.id)).toEqual(MIGRATIONS.map((_step, i) => i + 1));
    expect(new Set(MIGRATIONS.map((step) => step.name)).size).toBe(MIGRATIONS.length);
  });

  it('only add: none of them drops a table, renames a column or deletes a row', () => {
    for (const step of MIGRATIONS) {
      const source = step.up.toString();
      expect(source, step.name).not.toMatch(/DROP\s+TABLE/i);
      expect(source, step.name).not.toMatch(/DROP\s+COLUMN/i);
      expect(source, step.name).not.toMatch(/RENAME/i);
      expect(source, step.name).not.toMatch(/DELETE\s+FROM/i);
      expect(source, step.name).not.toMatch(/UPDATE\s+record/i);
      expect(source, step.name).not.toMatch(/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+record/i);
    }
  });
});

describe.each(FIXTURES)('a household left at $name', (fixture) => {
  it('wakes, keeps every row it had and serves them over the ordinary pull', async () => {
    const hid = freshHid();
    await seed(hid, fixture.sql);

    const pulled = await pullAll(hid, fixture.secret);
    expect(pulled.status).toBe(200);
    expect(pulled.json.seq).toBe(3);
    expect(pulled.json.records.map((r) => r.id)).toEqual(fixture.ids);
    expect(pulled.json.records.map((r) => r.deleted)).toEqual([false, false, true]);
    expect(pulled.json.records[0].body).toBe('Y2lwaGVyMQ==');

    await inside(hid, (sql) => {
      expect(columns(sql, 'record')).toEqual(RECORD_COLUMNS);
      expect(columns(sql, 'device')).toEqual(DEVICE_COLUMNS);
      expect(taken(sql).map((row) => row.id)).toEqual([1, 2, 3]);
      expect([...sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM record')][0].n).toBe(3);
      // The one free identity rebinding is for a token that predates identity, and for nobody else.
      expect([...sql.exec<{ identity_locked: number }>('SELECT identity_locked FROM device')][0].identity_locked).toBe(fixture.locked);
      // The old index is gone and the one the pull uses is still there.
      const indexes = [...sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")].map((r) => r.name);
      expect(indexes).toContain('record_seq');
      expect(indexes).not.toContain('record_scope_seq');
    });
  });

  it('takes writes after the upgrade, and the counters agree with the rows', async () => {
    const hid = freshHid();
    await seed(hid, fixture.sql);
    const push = await SELF.fetch('https://sync.test/v1/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${hid}.${fixture.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        records: [
          { id: 'fresh-1', scope: fixture.scope, updatedAt: 9000, device: 'd', nonce: 'nn', body: 'ZWRpdGVk' },
          { id: 'fresh-2', scope: fixture.scope, updatedAt: 9000, device: 'd', nonce: 'nn', body: 'bmV3' },
        ],
      }),
    });
    expect(push.status).toBe(200);
    const pulled = await pullAll(hid, fixture.secret);
    expect(pulled.json.records.map((r) => r.id)).toEqual([...fixture.ids, 'fresh-1', 'fresh-2']);
    await inside(hid, (sql) => {
      const kept = JSON.parse([...sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'counts'")][0].v);
      const counted = [...sql.exec(
        'SELECT COUNT(*) FILTER (WHERE deleted = 0) AS live, COUNT(*) AS stored, ' +
          'COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM record',
      )][0];
      expect(kept).toEqual({ ...counted });
    });
  });

  it('is not migrated twice: a second wake changes nothing, down to the time a step was taken', async () => {
    const hid = freshHid();
    await seed(hid, fixture.sql);
    await pullAll(hid, fixture.secret);
    const before = await inside(hid, taken);
    await abortAllDurableObjects();
    await pullAll(hid, fixture.secret);
    expect(await inside(hid, taken)).toEqual(before);
    // Production's own rows survive: steps 2 and 3 keep the time they were recorded.
    if (fixture.name === 'schema 3') {
      expect(before.filter((row) => row.id !== 1).map((row) => row.applied_at)).toEqual(['2026-08-06 00:00:00', '2026-08-06 00:00:00']);
    }
  });
});

describe('the framework', () => {
  it('gives a household made today the same tables the old migrate() made', async () => {
    const hid = freshHid();
    const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['personal:her'] }),
    });
    expect(res.status).toBe(200);
    await inside(hid, (sql) => {
      expect(columns(sql, 'record')).toEqual(RECORD_COLUMNS);
      expect(columns(sql, 'device')).toEqual(DEVICE_COLUMNS);
      expect(taken(sql).map((row) => row.id)).toEqual([1, 2, 3]);
      // A fresh household's default is the locked one, as it always was.
      const column = [...sql.exec<{ name: string; dflt_value: string }>('PRAGMA table_info(device)')].find((c) => c.name === 'identity_locked')!;
      expect(column.dflt_value).toBe('1');
    });
  });

  it('leaves alone an object a newer Worker has taken further than this one knows', async () => {
    const hid = freshHid();
    await seed(hid, v3);
    await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => {
      state.storage.sql.exec('INSERT INTO _sql_schema_migrations (id) VALUES (99)');
    });
    await abortAllDurableObjects();
    expect((await pullAll(hid, '3'.repeat(64))).status).toBe(200);
    expect((await inside(hid, taken)).map((row) => row.id)).toEqual([1, 2, 3, 99]);
  });

  it('takes a step and the row recording it in one transaction: a step that fails leaves neither', async () => {
    const hid = freshHid();
    await seed(hid, v3);
    await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => {
      const additive: Migration = {
        id: 4,
        name: 'a test column',
        up: (sql) => sql.exec("ALTER TABLE record ADD COLUMN probe TEXT NOT NULL DEFAULT ''"),
      };
      const broken: Migration = {
        id: 5,
        name: 'adds a column, then fails',
        up(sql) {
          sql.exec('ALTER TABLE device ADD COLUMN half_done INTEGER');
          throw new Error('boom');
        },
      };
      expect(() => runMigrations(state.storage, [...MIGRATIONS, additive, broken])).toThrow('boom');
      const sql = state.storage.sql;
      // The step before it stood; the one that failed left nothing behind, so the next wake retries it whole.
      expect(taken(sql).map((row) => row.id)).toEqual([1, 2, 3, 4]);
      expect(columns(sql, 'record')).toContain('probe');
      expect(columns(sql, 'device')).not.toContain('half_done');
      // And adding a column kept every row.
      expect([...sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM record')][0].n).toBe(3);
    });
  });
});
