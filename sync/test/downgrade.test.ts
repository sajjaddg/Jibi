import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { importSigningKey, signEntitlement } from '../../billing/src/entitlement';
import { TEST_SIGNING_KEY } from '../../billing/test/test-signing-key';
import { QUOTAS } from '../src/plans';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Pro, then more than free allows, then the end of Pro (#51), with plan limits on: everything can
 * still be read, edited, deleted and taken out; only something new is refused; nothing is removed.
 */

const json = { 'content-type': 'application/json' };
const DAY = 24 * 60 * 60 * 1000;
type Body = Record<string, any>;

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function claim(hid: string, type: string, scope: string) {
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ type, scopes: [scope], memberId: 'a1'.repeat(16), deviceId: 'a2'.repeat(16) }),
  });
  const token = `${hid}.${((await res.json()) as Body).secret}`;
  await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (instance) => {
    Object.assign(instance, { metered: () => true });
  });
  return token;
}

async function join(owner: string, n: number) {
  const invite = await call(owner, '/v1/invite', {});
  expect(invite.status).toBe(200);
  const paired = await call(owner, '/v1/pair', { code: invite.body.code, memberId: `${n}1`.repeat(16), deviceId: `${n}2`.repeat(16) });
  expect(paired.status).toBe(200);
  return `${owner.split('.')[0]}.${paired.body.secret}`;
}

const buy = async (token: string, days: number) => call(token, '/v1/entitlement', {
  entitlement: await signEntitlement(
    { v: 1, plan: 'pro', exp: Math.floor(Date.now() / DAY) * DAY + days * DAY, iat: Math.floor(Date.now() / DAY) * DAY, slot: '7c'.repeat(16) },
    await importSigningKey(TEST_SIGNING_KEY),
  ),
});

/** What time does: the stored end of the plan is now well past, grace and all. */
const lapse = (token: string) => runInDurableObject(env.HOUSEHOLD.getByName(token.split('.')[0]), async (_i, state) => {
  const row = [...state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plan'")][0];
  state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'plan'", JSON.stringify({ ...JSON.parse(row.v), exp: Date.now() - 30 * DAY }));
});

/** Every row in the object, which is what must not shrink. */
const rows = (token: string) => runInDurableObject(env.HOUSEHOLD.getByName(token.split('.')[0]), async (_i, state) => ({
  records: [...state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM record')][0].n,
  devices: [...state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM device')][0].n,
}));

/** Pull from the start to the end: what an export, a backup or a new screen reads. */
async function everything(token: string) {
  const ids: string[] = [];
  for (let since = 0;;) {
    const page = await call(token, `/v1/sync?since=${since}&limit=100`);
    expect(page.status).toBe(200);
    ids.push(...(page.body.records as Body[]).filter((r) => !r.deleted).map((r) => r.id));
    since = page.body.seq;
    if (!page.body.hasMore) return ids.sort();
  }
}

const record = (scope: string, id: string, updatedAt: number, size = 200, deleted = false) =>
  ({ id, scope, updatedAt, device: 'p', nonce: 'nn', body: 'A'.repeat(size), deleted });

describe('after Pro ends', () => {
  it('a family of four on a plan for two keeps all four, reads, edits and deletes, and cannot invite', async () => {
    const scope = 'family:down';
    const founder = await claim('4d'.repeat(16), 'family', scope);
    expect((await buy(founder, 30)).body.plan).toBe('pro');
    const everyone = [founder];
    for (const n of [3, 4, 5]) everyone.push(await join(founder, n));
    for (const [i, token] of everyone.entries()) {
      expect((await call(token, '/v1/sync', { records: [record(scope, `row-${i}`, 1000)] })).status).toBe(200);
    }
    const before = await rows(founder);
    await lapse(founder);

    expect((await call(founder, '/v1/hello')).body).toMatchObject({
      plan: 'free', quota: QUOTAS.family.free, used: { devices: 4, members: 4 },
    });
    for (const [i, token] of everyone.entries()) {
      expect(await everything(token)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
      const edit = await call(token, '/v1/sync', { records: [record(scope, `row-${i}`, 2000, 150)] });
      expect(edit.body).not.toHaveProperty('rejected');
    }
    expect((await call(everyone[3], '/v1/sync', { records: [record(scope, 'row-3', 3000, 10, true)] })).body).not.toHaveProperty('rejected');
    expect(await everything(founder)).toEqual(['row-0', 'row-1', 'row-2']);
    for (const token of everyone) {
      expect((await call(token, '/v1/invite', {})).body).toMatchObject({ code: 'quota_exceeded' });
    }
    expect(await rows(founder)).toEqual(before);

    // Buying again opens the door at once.
    expect((await buy(everyone[2], 30)).body.plan).toBe('pro');
    expect((await call(founder, '/v1/invite', {})).status).toBe(200);
  });

  it('a vault over the free size gives all of it back, takes edits and deletes, and only holds off on new', async () => {
    const scope = 'vault:down';
    const vault = await claim('4e'.repeat(16), 'personal', scope);
    await buy(vault, 30);
    const second = await join(vault, 3);
    await join(vault, 4);
    await call(vault, '/v1/sync', { records: [record(scope, 'one', 1000), record(scope, 'two', 1000)] });
    // Past the free 32 MiB without pushing that much: the kept count is what the limit reads.
    await runInDurableObject(env.HOUSEHOLD.getByName('4e'.repeat(16)), async (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'counts'", JSON.stringify({ live: 2, stored: 2, bytes: 100 * 1024 * 1024 }));
    });
    const before = await rows(vault);
    await lapse(vault);

    expect(await everything(second)).toEqual(['one', 'two']);
    const res = await call(second, '/v1/sync', {
      records: [record(scope, 'one', 2000, 200), record(scope, 'two', 2000, 10, true), record(scope, 'three', 1000)],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.rejected).toMatchObject([{ id: 'three', code: 'quota_exceeded', what: 'bytes' }]);
    expect(await everything(vault)).toEqual(['one']);
    expect(await rows(vault)).toEqual(before);
    // A third device beyond the free two is already hers and stays.
    expect((await call(vault, '/v1/devices')).body.devices).toHaveLength(3);
  });
});
