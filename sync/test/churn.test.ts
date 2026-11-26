import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Three years of one household's writes, edits and deletions, with compaction run on a simulated
 * clock, over the ordinary push and pull. What must hold at the end: the household is far
 * under its ceilings, a phone that kept up has exactly what is live, and a phone that spent the
 * whole time in a drawer is told to start over and ends with the same. It also prints what the
 * figures in docs/backend-plan.md come from: rows, bytes and the SQLite rows read and written.
 *
 * `pnpm run check` runs the heavy profile at a twentieth of its volume, syncing monthly. The
 * report's figures are each profile at full volume, syncing weekly, one at a time (the second of
 * two in one run is several times slower):
 *
 *   cd sync && CHURN=full pnpm exec vitest run test/churn.test.ts --reporter=verbose -t ordinary
 *   cd sync && CHURN=full pnpm exec vitest run test/churn.test.ts --reporter=verbose -t heavy
 */

/** «full» runs the report's volume; anything else a twentieth of it (vitest.config.ts). */
const FULL = (env as unknown as { CHURN?: string }).CHURN === 'full';
const DAY = 24 * 60 * 60 * 1000;
const SCOPE = 'vault:churn';
const DAYS = 3 * 365;
const json = { 'content-type': 'application/json' };

/** Per simulated day. «heavy» also writes rows it deletes a month later, ten times the burying. */
interface Profile { name: string; created: number; edited: number; deleted: number; shortLived: number }
const ORDINARY: Profile = { name: 'ordinary', created: 23, edited: 12, deleted: 3, shortLived: 0 };
const HEAVY: Profile = { name: 'heavy', created: 23, edited: 20, deleted: 5, shortLived: 45 };

/** Seeded, so two runs make the same history. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sent { id: string; scope: string; kind: string; updatedAt: number; device: string; nonce: string; body: string; deleted: boolean }
interface Page { seq: number; hasMore: boolean; horizon: number; records: { id: string; deleted: boolean; updatedAt: number }[] }
/** What a phone holds: its live rows by id, and the stamp each was written with. */
interface Phone { token: string; since: number; rows: Map<string, number> }

async function claim(hid: string): Promise<Phone> {
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId: 'a1'.repeat(16), deviceId: 'a2'.repeat(16) }),
  });
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, since: 0, rows: new Map() };
}

async function pair(owner: Phone, hid: string, tag: string): Promise<Phone> {
  const auth = { authorization: `Bearer ${owner.token}`, ...json };
  const invite = await SELF.fetch('https://sync.test/v1/invite', { method: 'POST', headers: auth, body: '{}' });
  const { code } = (await invite.json()) as { code: string };
  const res = await SELF.fetch('https://sync.test/v1/pair', {
    method: 'POST', headers: auth, body: JSON.stringify({ code, memberId: `${tag}1`.repeat(16), deviceId: `${tag}2`.repeat(16) }),
  });
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, since: 0, rows: new Map() };
}

async function push(phone: Phone, records: Sent[]) {
  for (let at = 0; at < records.length; at += 500) {
    const res = await SELF.fetch('https://sync.test/v1/sync', {
      method: 'POST', headers: { authorization: `Bearer ${phone.token}`, ...json },
      body: JSON.stringify({ records: records.slice(at, at + 500) }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }
}

/** Reads to the end and applies; false if told to start over. */
async function catchUp(phone: Phone, live = false): Promise<boolean> {
  for (;;) {
    const res = await SELF.fetch(`https://sync.test/v1/sync?since=${phone.since}&limit=1000${live ? '&live=1' : ''}`, {
      headers: { authorization: `Bearer ${phone.token}` },
    });
    if (res.status === 410) {
      await res.text();
      return false;
    }
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    for (const r of page.records) {
      if (r.deleted) phone.rows.delete(r.id);
      else phone.rows.set(r.id, r.updatedAt);
    }
    phone.since = page.seq;
    if (!page.hasMore) return true;
  }
}

function inside<T>(hid: string, read: (instance: any, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(env.HOUSEHOLD.getByName(hid), async (instance, state) => read(instance, state.storage.sql));
}

/** The SQLite rows the object read and wrote while `work` ran: what Cloudflare bills. */
async function billed(hid: string, work: () => Promise<unknown>): Promise<{ read: number; written: number }> {
  const cursors: { rowsRead: number; rowsWritten: number }[] = [];
  let real!: SqlStorage;
  await inside(hid, (instance) => {
    real = instance.sql;
    instance.sql = {
      exec: (...args: [string, ...unknown[]]) => {
        const cursor = real.exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    };
  });
  await work();
  // Read inside the object: a cursor belongs to it and cannot be touched from the test.
  return inside(hid, (instance) => {
    instance.sql = real;
    return {
      read: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
      written: cursors.reduce((sum, c) => sum + c.rowsWritten, 0),
    };
  });
}

/** `every` is how many days pass between the phones' syncs, and between compactions. */
async function simulate(profile: Profile, volume: number, every: number, hid: string) {
  const random = prng(profile.name.length);
  const a = await claim(hid);
  const b = await pair(a, hid, 'b');
  const drawer = await pair(a, hid, 'c');
  const start = Date.now() - DAYS * DAY;
  const body = (length: number) => 'A'.repeat(length);
  const sizes = () => 130 + Math.floor(random() * 500);
  const record = (id: string, day: number, deleted = false): Sent => ({
    id, scope: SCOPE, kind: 'legacy', updatedAt: start + day * DAY, device: 'churn', nonce: 'bm9uY2Vub25jZQ==',
    body: deleted ? body(40) : body(sizes()), deleted,
  });

  // What is live, as the phones should end up seeing it.
  const truth = new Map<string, number>();
  const ids: string[] = [];
  const shortLived: { id: string; dies: number }[] = [];
  let next = 0;
  let week: Sent[] = [];
  let writes = 0;
  const count = (n: number) => {
    const scaled = n * volume;
    return Math.floor(scaled) + (random() < scaled % 1 ? 1 : 0);
  };
  const write = (r: Sent) => {
    week.push(r);
    writes += 1;
    if (r.deleted) truth.delete(r.id);
    else truth.set(r.id, r.updatedAt);
  };
  const take = () => ids[Math.floor(random() * ids.length)];
  const peaks = { stored: 0, tombstones: 0, bytes: 0 };
  let purged = 0;

  for (let day = 0; day < DAYS; day++) {
    for (let i = count(profile.created); i > 0; i--) {
      const id = `r:${next++}`;
      ids.push(id);
      write(record(id, day));
    }
    // One stamp per id and day: a second write on the same stamp would be the one the server skips.
    const touched = new Set<string>();
    for (let i = count(profile.edited); i > 0 && ids.length > 0; i--) {
      const id = take();
      if (!touched.has(id) && truth.has(id) && truth.get(id) !== start + day * DAY) write(record(id, day));
      touched.add(id);
    }
    for (let i = count(profile.deleted); i > 0 && ids.length > 0; i--) {
      const id = take();
      if (!touched.has(id) && truth.has(id) && truth.get(id) !== start + day * DAY) write(record(id, day, true));
      touched.add(id);
    }
    for (let i = count(profile.shortLived); i > 0; i--) {
      const id = `t:${next++}`;
      write(record(id, day));
      shortLived.push({ id, dies: day + 30 });
    }
    while (shortLived.length > 0 && shortLived[0].dies <= day) write(record(shortLived.shift()!.id, day, true));

    if (day % every !== every - 1 && day !== DAYS - 1) continue;
    await push(a, week);
    week = [];
    expect(await catchUp(a)).toBe(true);
    // A pull acknowledges what it asked after, so a phone that kept up asks once more.
    expect(await catchUp(a)).toBe(true);
    expect(await catchUp(b)).toBe(true);
    // The drawer phone reads the first week and is not picked up again.
    if (day === every - 1) await catchUp(drawer);
    await inside(hid, (instance, sql) => {
      const row = [...sql.exec<{ stored: number; tombstones: number; bytes: number }>(
        'SELECT COUNT(*) AS stored, COUNT(*) FILTER (WHERE deleted = 1) AS tombstones, ' +
          'COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM record',
      )][0];
      peaks.stored = Math.max(peaks.stored, row.stored);
      peaks.tombstones = Math.max(peaks.tombstones, row.tombstones);
      peaks.bytes = Math.max(peaks.bytes, row.bytes);
      for (;;) {
        const run = instance.compact(start + (day + 1) * DAY);
        purged += run.purged;
        if (!run.capped) break;
      }
    });
  }
  await catchUp(b);

  const end = await inside(hid, (_instance, sql) => ({
    ...[...sql.exec<{ stored: number; live: number; tombstones: number; bytes: number }>(
      'SELECT COUNT(*) AS stored, COUNT(*) FILTER (WHERE deleted = 0) AS live, ' +
        'COUNT(*) FILTER (WHERE deleted = 1) AS tombstones, ' +
        'COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM record',
    )][0],
    kept: JSON.parse([...sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'counts'")][0].v),
    database: sql.databaseSize,
  }));

  return { a, b, drawer, truth, writes, purged, peaks, end };
}

const sorted = (rows: Map<string, number>) => [...rows].sort(([x], [y]) => x.localeCompare(y));

describe.each(FULL ? [ORDINARY, HEAVY] : [HEAVY])('three years of $name churn', (profile) => {
  it('stays far under the ceilings, and every phone ends with exactly what is live', async () => {
    const volume = FULL ? 1 : 0.05;
    const every = FULL ? 7 : 28;
    const hid = (profile === ORDINARY ? 'c1' : 'c2').repeat(16);
    const { a, b, drawer, truth, writes, purged, peaks, end } = await simulate(profile, volume, every, hid);

    expect(end.kept).toEqual({ live: end.live, stored: end.stored, bytes: end.bytes });
    expect(end.live).toBe(truth.size);
    expect(purged).toBeGreaterThan(0);
    // Only the last ninety days of deletions are left, with the slack of two syncs between runs.
    expect(end.tombstones).toBeLessThanOrEqual((profile.deleted + profile.shortLived) * volume * (90 + 2 * every) + 20);
    expect(peaks.stored).toBeLessThan(4 * 120_000 / 2);
    expect(end.live).toBeLessThan(120_000);
    expect(peaks.bytes).toBeLessThan(256 * 1024 * 1024);

    expect(sorted(a.rows)).toEqual(sorted(truth));
    expect(sorted(b.rows)).toEqual(sorted(truth));

    // The drawer phone: refused, then rebuilt from nothing with `live=1`.
    expect(await catchUp(drawer)).toBe(false);
    drawer.since = 0;
    drawer.rows.clear();
    expect(await catchUp(drawer, true)).toBe(true);
    expect(sorted(drawer.rows)).toEqual(sorted(truth));

    // What each call costs in rows, on the household as it now stands.
    const idle = await billed(hid, () => catchUp(a));
    const one = await billed(hid, () => push(a, [{ ...recordNow('probe-new') }]));
    const edit = await billed(hid, () => push(a, [{ ...recordNow('probe-new'), updatedAt: Date.now() + 1 }]));
    const fromZero = await billed(hid, () => catchUp({ token: a.token, since: 0, rows: new Map() }, true));
    const compaction = await billed(hid, () => inside(hid, (instance) => instance.compact(Date.now())));

    console.log(JSON.stringify({
      profile: profile.name, volume, every, writes, purged, peaks, end,
      rows: { idlePull: idle, pushOneNew: one, pushOneEdit: edit, pullFromZero: fromZero, compaction },
    }));
  }, 3_600_000);
});

function recordNow(id: string): Sent {
  return { id, scope: SCOPE, kind: 'legacy', updatedAt: Date.now(), device: 'churn', nonce: 'bm4=', body: 'Ym9keQ==', deleted: false };
}
