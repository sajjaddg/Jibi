import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { effectivePlan, PLAN_GRACE_MS, PLAN_LIMITS_ENFORCED, QUOTAS } from '../src/plans';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Plan quotas. They ship switched off, so the first thing checked is that nothing is limited; the
 * rest runs the object with them on. The rule under test throughout: a plan refuses what is new
 * and takes nothing away.
 */

const json = { 'content-type': 'application/json' };
const SCOPE = 'scope:q';
const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const KIT = 'c4'.repeat(32);

let next = 0;
interface Device { token: string; hid: string; deviceId: string }

const id = (tag: string, n: number) => `${tag}${n.toString(16).padStart(2, '0')}`.repeat(8);

async function claim(type: 'family' | 'personal'): Promise<Device> {
  next += 1;
  const hid = id('4a', next);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ type, scopes: [SCOPE], memberId: id('a1', 0), deviceId: id('d0', 0), ...(type === 'personal' ? { recovery: KIT } : {}) }),
  });
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, hid, deviceId: id('d0', 0) };
}

type Body = Record<string, any>;

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function join(owner: Device, n: number) {
  const invite = await call(owner.token, '/v1/invite', {});
  if (invite.status !== 200) return { invite, pair: null, device: null };
  const pair = await call(owner.token, '/v1/pair', { code: invite.body.code, memberId: id('b0', n), deviceId: id('e0', n) });
  return { invite, pair, device: { token: `${owner.hid}.${pair.body.secret}`, hid: owner.hid, deviceId: id('e0', n) } };
}

const record = (recordId: string, bytes: number, updatedAt = 1000, deleted = false) =>
  ({ id: recordId, scope: SCOPE, updatedAt, device: 'p', nonce: 'nn', body: 'A'.repeat(bytes), deleted });

const push = (device: Device, records: unknown[]) => call(device.token, '/v1/sync', { records });

const inside = <T>(hid: string, read: (instance: any, sql: SqlStorage) => T) =>
  runInDurableObject(env.HOUSEHOLD.getByName(hid), async (instance, state) => read(instance, state.storage.sql));

/** What flipping the constant does, for one object. */
const enforce = (hid: string) => inside(hid, (instance) => { instance.metered = () => true; });

const givePro = (hid: string, exp: number) => inside(hid, (_i, sql) => {
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('plan', ?)", JSON.stringify({ plan: 'pro', exp, slot: 'f'.repeat(32) }));
});

const counted = (hid: string) => inside(hid, (_i, sql) => ({
  devices: [...sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device')][0].n,
  records: [...sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM record')][0].n,
}));

/** Puts the household's size at `bytes` without pushing that much: `grown` reads the kept count. */
const fill = (hid: string, bytes: number) => inside(hid, (_i, sql) => {
  const kept = JSON.parse([...sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'counts'")][0].v);
  sql.exec("UPDATE meta SET v = ? WHERE k = 'counts'", JSON.stringify({ ...kept, bytes }));
});

describe('as shipped', () => {
  it('limits nothing: the switch is off and a household has only the hard ceilings', async () => {
    expect(PLAN_LIMITS_ENFORCED).toBe(false);
    const family = await claim('family');
    for (let n = 1; n <= 5; n++) expect((await join(family, n)).pair!.status).toBe(200);
    const vault = await claim('personal');
    for (let n = 1; n <= 4; n++) expect((await join(vault, n)).pair!.status).toBe(200);
    for (const [household, devices] of [[family, 6], [vault, 5]] as const) {
      const hello = await call(household.token, '/v1/hello');
      expect(hello.body).toMatchObject({ plan: 'free', quota: { devices: 16, members: 16, bytes: 256 * MIB } });
      expect(hello.body.used.devices).toBe(devices);
    }
    // Past the free vault's 32 MiB and still taken.
    await push(vault, [record('r1', 10)]);
    await fill(vault.hid, 40 * MIB);
    expect((await push(vault, [record('r2', 100)])).body).not.toHaveProperty('rejected');
  });
});

describe('the table', () => {
  it('is the one decided in #16', () => {
    expect(QUOTAS).toEqual({
      personal: { free: { devices: 2, members: 1, bytes: 32 * MIB }, pro: { devices: 8, members: 1, bytes: 256 * MIB } },
      family: { free: { devices: 4, members: 2, bytes: 256 * MIB }, pro: { devices: 16, members: 8, bytes: 256 * MIB } },
    });
  });

  it('keeps Pro for seven days past the entitlement, and no longer', () => {
    const stored = { plan: 'pro' as const, exp: 1_000_000, slot: 's' };
    expect(PLAN_GRACE_MS).toBe(7 * DAY);
    expect(effectivePlan(stored, stored.exp + 7 * DAY)).toBe('pro');
    expect(effectivePlan(stored, stored.exp + 7 * DAY + 1)).toBe('free');
    expect(effectivePlan(null, 0)).toBe('free');
  });
});

describe('with limits on', () => {
  it('gives a free vault two devices, and says which limit and how full', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    expect((await join(vault, 1)).pair!.status).toBe(200);
    const third = await join(vault, 2);
    expect(third.invite).toEqual({ status: 409, body: { code: 'quota_exceeded', what: 'devices', limit: 2, used: 2 } });
    expect((await call(vault.token, '/v1/hello')).body).toMatchObject({ plan: 'free', quota: { devices: 2, members: 1, bytes: 32 * MIB } });
  });

  it('gives a free family two members', async () => {
    const family = await claim('family');
    await enforce(family.hid);
    expect((await join(family, 1)).pair!.status).toBe(200);
    expect((await join(family, 2)).invite).toEqual({ status: 409, body: { code: 'quota_exceeded', what: 'members', limit: 2, used: 2 } });
  });

  it('checks again at pair, for a code shown while there was room', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    const early = (await call(vault.token, '/v1/invite', {})).body.code;
    expect((await join(vault, 1)).pair!.status).toBe(200);
    expect(await call(vault.token, '/v1/pair', { code: early, deviceId: id('e0', 9) }))
      .toEqual({ status: 409, body: { code: 'quota_exceeded', what: 'devices', limit: 2, used: 2 } });
  });

  it('makes room for more under Pro', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    await givePro(vault.hid, Date.now() + DAY);
    for (let n = 1; n <= 7; n++) expect((await join(vault, n)).pair!.status).toBe(200);
    expect((await join(vault, 8)).invite.body).toMatchObject({ code: 'quota_exceeded', limit: 8 });
  });

  it('after Pro lapses with five devices, removes none: all still pull, edit and delete', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    await givePro(vault.hid, Date.now() + DAY);
    const devices = [vault];
    for (let n = 1; n <= 4; n++) devices.push((await join(vault, n)).device!);
    await push(vault, [record('r1', 40), record('r2', 40)]);
    await givePro(vault.hid, Date.now() - 8 * DAY);
    await fill(vault.hid, 200 * MIB); // far over the free 32 MiB
    const before = await counted(vault.hid);

    for (const [n, device] of devices.entries()) {
      expect((await call(device.token, '/v1/sync?since=0')).status).toBe(200);
      // The same size, then smaller, then a delete: each accepted. `size` is what r1 is now.
      const size = 40 - n * 4;
      for (const r of [record('r1', size, 2000 + n * 10), record('r1', size - 4, 2001 + n * 10), record('r2', 10, 2002 + n * 10, true)]) {
        const res = await push(device, [r]);
        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty('rejected');
      }
    }
    // A delete of something this household never had is a delete too.
    expect((await push(vault, [record('never-seen', 30, 9000, true)])).body).not.toHaveProperty('rejected');
    expect(await counted(vault.hid)).toEqual({ devices: before.devices, records: before.records + 1 });
    expect((await call(vault.token, '/v1/hello')).body).toMatchObject({ plan: 'free', used: { devices: 5 } });
    expect((await join(vault, 5)).invite.body).toEqual({ code: 'quota_exceeded', what: 'devices', limit: 2, used: 5 });
  });

  it('refuses only what would grow past the size, record by record, and stores the rest', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    await push(vault, [record('old', 100)]);
    await fill(vault.hid, 32 * MIB);
    const res = await push(vault, [record('new', 50), record('old', 200, 2000), record('old', 60, 3000), record('gone', 5, 1000, true)]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.rejected).toEqual([
      { id: 'new', code: 'quota_exceeded', what: 'bytes', limit: 32 * MIB, used: 32 * MIB },
      { id: 'old', code: 'quota_exceeded', what: 'bytes', limit: 32 * MIB, used: 32 * MIB },
    ]);
    const stored = (await call(vault.token, '/v1/sync?since=0')).body.records as { id: string; body: string }[];
    expect(stored.map((r) => [r.id, r.body.length])).toEqual([['old', 60], ['gone', 5]]);
  });

  it('holds a recovering phone to the device limit, and lets it swap one out', async () => {
    const vault = await claim('personal');
    await enforce(vault.hid);
    await join(vault, 1);
    const recover = (body: Body) => call('', '/v1/recover', { hid: vault.hid, recovery: KIT, ...body });
    const full = await recover({ deviceId: id('f0', 1) });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ code: 'quota_exceeded', what: 'devices', limit: 2, used: 2 });
    expect(full.body.devices).toHaveLength(2);
    expect((await recover({ deviceId: id('f0', 1), revoke: vault.deviceId })).status).toBe(200);
    expect((await counted(vault.hid)).devices).toBe(2);
  });

  it('leaves leaving and removing alone: neither is something new', async () => {
    const family = await claim('family');
    await givePro(family.hid, Date.now() + DAY);
    await enforce(family.hid);
    const other = (await join(family, 1)).device!;
    await push(family, [record('r1', 10)]);
    await givePro(family.hid, 0);
    await fill(family.hid, 255 * MIB);
    const tombstone = {
      id: `member:${id('b0', 1)}`, scope: SCOPE, kind: 'member', ownerMemberId: id('b0', 1), updatedAt: 1,
      device: 'p', nonce: 'nn', body: 'YQ==', deleted: true,
    };
    expect((await call(other.token, '/v1/leave', { record: tombstone })).status).toBe(200);
  });
});
