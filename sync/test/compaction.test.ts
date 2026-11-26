import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Device cursors, tombstone compaction and the start-over a phone is told to make when it has
 * fallen behind what compaction removed. Stamps are relative to now because the rules are about
 * age: a tombstone must be 90 days old to go, and a device is waited for until the first thing it
 * has not read is 180 days old.
 */

const DAY = 24 * 60 * 60 * 1000;
const json = { 'content-type': 'application/json' };
const SCOPE = 'family:c';

let next = 0;
function freshHid(): string {
  next += 1;
  return `cc${next.toString(16).padStart(2, '0')}`.repeat(8);
}

interface Device { token: string; hid: string; memberId: string; deviceId: string }

async function claim(hid: string): Promise<Device> {
  const memberId = 'a1'.repeat(16);
  const deviceId = 'a2'.repeat(16);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId, deviceId }),
  });
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, hid, memberId, deviceId };
}

/** A second device of the same person, so the household has two readers. */
async function pairSecond(owner: Device): Promise<Device> {
  const invite = await SELF.fetch('https://sync.test/v1/invite', {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, ...json }, body: '{}',
  });
  const { code } = (await invite.json()) as { code: string };
  const memberId = 'b1'.repeat(16);
  const deviceId = 'b2'.repeat(16);
  const paired = await SELF.fetch('https://sync.test/v1/pair', {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, ...json }, body: JSON.stringify({ code, memberId, deviceId }),
  });
  expect(paired.status).toBe(200);
  const { secret } = (await paired.json()) as { secret: string };
  return { token: `${owner.hid}.${secret}`, hid: owner.hid, memberId, deviceId };
}

function rec(id: string, updatedAt: number, over: Record<string, unknown> = {}) {
  return { id, scope: SCOPE, updatedAt, device: 'p', nonce: 'nn', body: 'Ym9keQ==', ...over };
}

async function push(device: Device, records: unknown[]) {
  const res = await SELF.fetch('https://sync.test/v1/sync', {
    method: 'POST', headers: { authorization: `Bearer ${device.token}`, ...json }, body: JSON.stringify({ records }),
  });
  expect(res.status).toBe(200);
}

async function pull(device: Device, query: string) {
  const res = await SELF.fetch(`https://sync.test/v1/sync?${query}`, { headers: { authorization: `Bearer ${device.token}` } });
  return { status: res.status, body: (await res.json()) as { code?: string; horizon: number; seq: number; hasMore: boolean; records: { id: string; deleted: boolean }[] } };
}

function inside<T>(hid: string, read: (sql: SqlStorage, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => read(state.storage.sql, state));
}

const ids = (sql: SqlStorage) => [...sql.exec<{ id: string }>('SELECT id FROM record ORDER BY seq')].map((row) => row.id);
const acked = (sql: SqlStorage) => Object.fromEntries(
  [...sql.exec<{ id: string; acked_seq: number }>('SELECT id, acked_seq FROM device')].map((row) => [row.id, row.acked_seq]),
);

/** r1 written then buried, then r2: seqs 1, 2 (r1's tombstone replaces its row) and 3. */
async function buryOne(device: Device, buriedAgo: number) {
  const now = Date.now();
  await push(device, [rec('r1', now - buriedAgo - 1000)]);
  await push(device, [rec('r1', now - buriedAgo, { deleted: true, body: '' })]);
  await push(device, [rec('r2', now)]);
}

describe('what a device has read', () => {
  it('is the seq it asks after, a number that only moves forward and never passes the head', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 100 * DAY);
    await pull(a, 'since=2');
    expect(await inside(a.hid, acked)).toEqual({ [a.deviceId]: 2 });
    await pull(a, 'since=1');
    expect(await inside(a.hid, acked)).toEqual({ [a.deviceId]: 2 });
    // Claiming to hold what does not exist yet is not taken at its word.
    expect((await pull(a, 'since=99999')).status).toBe(200);
    expect(await inside(a.hid, acked)).toEqual({ [a.deviceId]: 3 });
  });

  it('is not moved by the clients’ token check, which asks past every number there is', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 299 * DAY);
    // Android sends Long.MAX_VALUE, the PWA Number.MAX_SAFE_INTEGER.
    for (const since of ['9223372036854775807', String(Number.MAX_SAFE_INTEGER)]) {
      expect((await pull(a, `since=${since}&limit=1`)).status).toBe(200);
    }
    expect(await inside(a.hid, acked)).toEqual({ [a.deviceId]: 0 });
  });

  it('is all the household keeps about when: no timestamp of a device appears anywhere in its tables', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 100 * DAY);
    await pull(a, 'since=3');
    await inside(a.hid, (sql) => {
      expect([...sql.exec<{ name: string; type: string }>('PRAGMA table_info(device)')].map((c) => c.name).sort())
        .toEqual(['acked_seq', 'added_at', 'id', 'identity_locked', 'last_seen', 'member_id', 'role', 'scopes', 'token_hash']);
      // last_seen is the day the device joined and stays so, as before.
      expect([...sql.exec<{ same: number }>('SELECT added_at = last_seen AS same FROM device')][0].same).toBe(1);
      expect([...sql.exec<{ k: string }>('SELECT k FROM meta ORDER BY k')].map((row) => row.k))
        .toEqual(['counts', 'primary_member', 'seq']);
    });
  });
});

describe('compaction', () => {
  it('waits for the slowest device, then removes the tombstone, and says where the horizon is', async () => {
    const a = await claim(freshHid());
    const b = await pairSecond(a);
    await buryOne(a, 100 * DAY);
    await pull(a, 'since=3');
    const stub = env.HOUSEHOLD.getByName(a.hid);

    // b has read nothing: the 100-day-old tombstone is its first unread row, which is recent
    // enough that it is waited for.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inside(a.hid, ids)).toEqual(['r1', 'r2']);
    expect((await pull(a, 'since=0')).body.horizon).toBe(0);

    await pull(b, 'since=2');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inside(a.hid, ids)).toEqual(['r2']);
    expect((await pull(b, 'since=2')).body.horizon).toBe(2);
    // The counters follow the rows.
    await inside(a.hid, (sql) => {
      const kept = JSON.parse([...sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'counts'")][0].v);
      expect(kept).toEqual({ live: 1, stored: 1, bytes: 'Ym9keQ=='.length });
    });
  });

  it('keeps a tombstone younger than ninety days however many devices have read it', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 10 * DAY);
    await pull(a, 'since=3');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    expect(await inside(a.hid, ids)).toEqual(['r1', 'r2']);
    expect((await pull(a, 'since=0')).body.horizon).toBe(0);
  });

  it('never removes a live row, however old and however many have read it', async () => {
    const a = await claim(freshHid());
    await push(a, [rec('old-1', Date.now() - 400 * DAY), rec('old-2', Date.now() - 500 * DAY)]);
    await pull(a, 'since=2');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    expect(await inside(a.hid, ids)).toEqual(['old-1', 'old-2']);
  });

  it('stops waiting for a device that has been behind for half a year', async () => {
    const a = await claim(freshHid());
    const b = await pairSecond(a);
    // The first thing b has not read was written 299 days ago.
    await buryOne(a, 299 * DAY);
    await pull(a, 'since=3');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    expect(await inside(a.hid, ids)).toEqual(['r2']);

    // When it comes back it is told to start over, and the start-over carries what is live.
    const refused = await pull(b, 'since=0');
    expect(refused.status).toBe(410);
    expect(refused.body).toEqual({ code: 'resync_required', horizon: 2 });
    const again = await pull(b, 'since=0&live=1');
    expect(again.status).toBe(200);
    expect(again.body.records.map((r) => r.id)).toEqual(['r2']);
    expect(again.body.seq).toBe(3);
    // From there it is an ordinary device again.
    expect((await pull(b, 'since=3')).status).toBe(200);
  });

  it('tells only a device that is behind the horizon, and not one that stands on it', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 299 * DAY);
    await pull(a, 'since=3');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    expect((await pull(a, 'since=1')).status).toBe(410);
    expect((await pull(a, 'since=2')).status).toBe(200);
    expect((await pull(a, 'since=3')).status).toBe(200);
  });

  it('sends a start-over the tombstones above the horizon, which may be the deletion of a row it already holds', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 299 * DAY);
    await pull(a, 'since=3');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    await push(a, [rec('r3', Date.now() - 1000)]);
    await push(a, [rec('r3', Date.now(), { deleted: true, body: '' })]);
    const walk = await pull(a, 'since=0&live=1');
    expect(walk.body.records.map((r) => [r.id, r.deleted])).toEqual([['r2', false], ['r3', true]]);
  });

  it('frees a household that has buried its way to the backstop, so it stops being full for ever', async () => {
    const a = await claim(freshHid());
    const stored = 4 * 120_000;
    await inside(a.hid, (sql) => {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${stored})
         INSERT INTO record (id, scope, seq, updated_at, device, kind, owner_member, author_member, deleted, nonce, body)
         SELECT 'gone-' || i, '${SCOPE}', i, 1000, 'seed', 'legacy', '', '', 1, 'n', '' FROM n`,
      );
      sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('seq', ?)", String(stored));
      sql.exec("DELETE FROM meta WHERE k = 'counts'");
    });
    // Woken the way a household older than the counters is, so the counts are taken from the rows.
    await abortAllDurableObjects();
    await pull(a, `since=${stored}`);

    const full = await SELF.fetch('https://sync.test/v1/sync', {
      method: 'POST', headers: { authorization: `Bearer ${a.token}`, ...json }, body: JSON.stringify({ records: [rec('one-too-many', Date.now())] }),
    });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ code: 'household_full' });

    // A day's compaction takes ten thousand rows and asks to be woken again soon.
    const stub = env.HOUSEHOLD.getByName(a.hid);
    let runs = 0;
    while (await inside(a.hid, (sql) => [...sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM record')][0].n) > 0) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      runs += 1;
      expect(runs).toBeLessThan(60);
    }
    expect(runs).toBe(48);
    await push(a, [rec('now-it-fits', Date.now())]);
    await inside(a.hid, (sql) => {
      const kept = JSON.parse([...sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'counts'")][0].v);
      expect(kept).toEqual({ live: 1, stored: 1, bytes: 'Ym9keQ=='.length });
    });
  }, 120_000);
});

describe('the daily alarm', () => {
  it('is set when a household is claimed, set again after it runs, and removed when the household closes', async () => {
    const a = await claim(freshHid());
    const stub = env.HOUSEHOLD.getByName(a.hid);
    const alarm = () => runInDurableObject(stub, async (_i, state) => state.storage.getAlarm());
    const first = await alarm();
    expect(first).not.toBeNull();
    expect(first! - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(first! - Date.now()).toBeLessThanOrEqual(DAY);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarm()).not.toBeNull();

    const revoked = await SELF.fetch('https://sync.test/v1/revoke', {
      method: 'POST', headers: { authorization: `Bearer ${a.token}`, ...json }, body: JSON.stringify({ member: a.memberId }),
    });
    expect(revoked.status).toBe(200);
    expect(await alarm()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('is given to a household that was made before there was one, the first time it wakes', async () => {
    const a = await claim(freshHid());
    await inside(a.hid, (_sql, state) => state.storage.deleteAlarm());
    await abortAllDurableObjects();
    expect((await pull(a, 'since=0')).status).toBe(200);
    expect(await inside(a.hid, (_sql, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('leaves an unclaimed household alone, so a stray alarm cannot bring one back', async () => {
    const hid = freshHid();
    const stub = env.HOUSEHOLD.getByName(hid);
    await inside(hid, (_sql, state) => state.storage.setAlarm(Date.now() + 1000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inside(hid, (sql) => [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")])).toEqual([]);
    expect(await inside(hid, (_sql, state) => state.storage.getAlarm())).toBeNull();
  });
});

describe('the compaction switch', () => {
  /** The object as production's config makes it: the switch is read from the env on every use. */
  const switchOff = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (instance) => {
    Object.assign(instance, { env: { ...env, COMPACTION: 'off' } });
  });

  it('is off in both environments the Worker is deployed to', () => {
    expect(config.match(/"COMPACTION":\s*"[^"]*"/g)).toEqual(['"COMPACTION": "off"', '"COMPACTION": "off"']);
  });

  it('keeps every tombstone and sets no alarm while it is off, so no device is told to start over', async () => {
    const hid = freshHid();
    await switchOff(hid);
    const a = await claim(hid);
    const stub = env.HOUSEHOLD.getByName(a.hid);
    const alarm = () => runInDurableObject(stub, async (_i, state) => state.storage.getAlarm());
    expect(await alarm()).toBeNull();

    // The case that is purged with the switch on: read by every device and long past ninety days.
    await buryOne(a, 299 * DAY);
    await pull(a, 'since=3');
    // An alarm left from while it was on runs once, purges nothing and is not set again.
    await runInDurableObject(stub, async (_i, state) => state.storage.setAlarm(Date.now() + 1000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inside(a.hid, ids)).toEqual(['r1', 'r2']);
    expect(await alarm()).toBeNull();

    // A client that has never heard of `live=1` pulls from zero and is answered as before.
    const fromZero = await pull(a, 'since=0');
    expect(fromZero.status).toBe(200);
    expect(fromZero.body.horizon).toBe(0);
    expect(fromZero.body.records.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('turned off again, still tells a device behind what was already removed', async () => {
    const a = await claim(freshHid());
    await buryOne(a, 299 * DAY);
    await pull(a, 'since=3');
    await runDurableObjectAlarm(env.HOUSEHOLD.getByName(a.hid));
    await switchOff(a.hid);
    expect((await pull(a, 'since=1')).status).toBe(410);
  });
});
