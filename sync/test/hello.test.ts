import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { KINDS, RESERVED_ID_PREFIXES } from '../src/kinds';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * `GET /v1/hello`: what the server accepts, before a client sends anything. The point is the last
 * test — a client that reads the list and holds back what is not on it keeps syncing the rest,
 * where one unknown kind used to 400 the whole batch.
 */

const json = { 'content-type': 'application/json' };

async function claim(hid: string, scopes = ['family:x'], identity: { memberId?: string; deviceId?: string } = {}) {
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes, ...identity }),
  });
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return `${hid}.${secret}`;
}

async function hello(token?: string) {
  const res = await SELF.fetch('https://sync.test/v1/hello', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

async function push(token: string, records: unknown[]) {
  return SELF.fetch('https://sync.test/v1/sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...json },
    body: JSON.stringify({ records }),
  });
}

describe('GET /v1/hello', () => {
  it('tells anyone the protocol and the kinds, and nothing about a household', async () => {
    const { res, body } = await hello();
    expect(res.status).toBe(200);
    expect(body).toEqual({ protocol: 2, kinds: [...KINDS] });
    // The same for everyone, so it may be cached for the minute the client caches it for.
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('tells a device what its household is, what it may hold and how much of that it holds', async () => {
    const hid = 'd1'.repeat(16);
    const token = await claim(hid, ['family:x'], { memberId: 'a1'.repeat(16), deviceId: 'a2'.repeat(16) });
    const first = await hello(token);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('cache-control')).toBe('no-store');
    expect(first.body).toEqual({
      protocol: 2,
      kinds: [...KINDS],
      type: 'family',
      plan: 'free',
      quota: { devices: 16, members: 16, bytes: 256 * 1024 * 1024 },
      used: { devices: 1, members: 1, bytes: 0 },
      minClient: { android: 0, pwa: 0 },
    });

    expect((await push(token, [
      { id: 'r1', scope: 'family:x', updatedAt: 1000, device: 'p', nonce: 'nn', body: 'x'.repeat(100) },
    ])).status).toBe(200);
    // A second device of the same person, then another person's.
    const invite = async (memberId: string, deviceId: string) => {
      const made = await SELF.fetch('https://sync.test/v1/invite', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: '{}',
      });
      const { code } = (await made.json()) as { code: string };
      expect((await SELF.fetch('https://sync.test/v1/pair', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify({ code, memberId, deviceId }),
      })).status).toBe(200);
    };
    await invite('b1'.repeat(16), 'b2'.repeat(16));
    const after = await hello(token);
    expect(after.body.used).toEqual({ devices: 2, members: 2, bytes: 100 });
  });

  it('refuses a token that is no good, as every other call does', async () => {
    const hid = 'd2'.repeat(16);
    const token = await claim(hid, ['family:x'], { memberId: 'c1'.repeat(16), deviceId: 'c2'.repeat(16) });
    expect((await hello(`${hid}.${'0'.repeat(64)}`)).res.status).toBe(401);
    expect((await hello('not-a-token')).res.status).toBe(401);
    expect((await hello(token)).res.status).toBe(200);
    // A device that was revoked learns it here, the same turn.
    const gone = await SELF.fetch('https://sync.test/v1/revoke', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify({ member: 'c1'.repeat(16) }),
    });
    expect(gone.status).toBe(200);
    expect((await hello(token)).res.status).toBe(401);
  });

  it('does not make a household out of a token for one nobody claimed', async () => {
    const hid = 'd3'.repeat(16);
    const { res } = await hello(`${hid}.${'1'.repeat(64)}`);
    expect(res.status).toBe(401);
    await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => {
      expect([...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")]).toEqual([]);
    });
  });

  it('writes nothing when it answers', async () => {
    const hid = 'd4'.repeat(16);
    const token = await claim(hid);
    const dump = () => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_instance, state) => ({
      meta: [...state.storage.sql.exec('SELECT * FROM meta ORDER BY k')],
      devices: [...state.storage.sql.exec('SELECT * FROM device ORDER BY id')],
      records: [...state.storage.sql.exec('SELECT * FROM record')],
    }));
    const before = await dump();
    await hello(token);
    await hello();
    expect(await dump()).toEqual(before);
  });
});

describe('the list of kinds', () => {
  it('is what the push validator accepts: a listed kind is never refused as a kind, an unlisted one always is', async () => {
    const hid = 'd5'.repeat(16);
    const token = await claim(hid);
    const { body } = await hello(token);
    for (const kind of body.kinds as string[]) {
      const res = await push(token, [
        { id: `probe:${kind}`, scope: 'family:x', updatedAt: 1, device: 'p', nonce: 'nn', body: '', kind },
      ]);
      // Other fences (owner, id namespace) may refuse a probe; the kind itself must not be why.
      const code = res.status === 200 ? '' : ((await res.json()) as { code: string }).code;
      expect(code, kind).not.toBe('invalid_kind');
    }
    const refused = await push(token, [
      { id: 'probe:x', scope: 'family:x', updatedAt: 1, device: 'p', nonce: 'nn', body: '', kind: 'sparkle' },
    ]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ code: 'invalid_kind' });
  });

  it('only names kinds in the id prefixes it reserves', () => {
    for (const [, kind] of RESERVED_ID_PREFIXES) expect(KINDS).toContain(kind);
  });

  it('lets a client that holds back what is not listed keep syncing the rest', async () => {
    const hid = 'd6'.repeat(16);
    const token = await claim(hid);
    const pending = [
      { id: 'note:one', scope: 'family:x', updatedAt: 1000, device: 'p', nonce: 'nn', body: 'YQ==', kind: 'note' },
      { id: 'vaultthing:1', scope: 'family:x', updatedAt: 1000, device: 'p', nonce: 'nn', body: 'Yg==', kind: 'sms' },
      { id: 'goal:two', scope: 'family:x', updatedAt: 1000, device: 'p', nonce: 'nn', body: 'Yw==', kind: 'goal' },
    ];
    // Without the list: the whole batch is refused, and a note and a goal that were fine go with it.
    const blind = await push(token, pending);
    expect(blind.status).toBe(400);

    const { body } = await hello();
    const accepted = pending.filter((r) => (body.kinds as string[]).includes(r.kind));
    const heldBack = pending.filter((r) => !(body.kinds as string[]).includes(r.kind));
    expect(heldBack.map((r) => r.id)).toEqual(['vaultthing:1']);
    expect((await push(token, accepted)).status).toBe(200);
    const pulled = await SELF.fetch('https://sync.test/v1/sync?since=0', { headers: { authorization: `Bearer ${token}` } });
    expect(((await pulled.json()) as { records: { id: string }[] }).records.map((r) => r.id)).toEqual(['note:one', 'goal:two']);
  });
});
