import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** `POST /v1/destroy`: the server forgets a household, and only the person who may ask it to. */

const json = { 'content-type': 'application/json' };
const SCOPE = 'family:d';

interface Device { token: string; hid: string; memberId: string }

async function claim(hid: string, memberId: string): Promise<Device> {
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId, deviceId: memberId.replace(/^./, 'f') }),
  });
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, hid, memberId };
}

async function join(owner: Device, memberId: string): Promise<Device> {
  const invite = await SELF.fetch('https://sync.test/v1/invite', {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, ...json }, body: '{}',
  });
  const { code } = (await invite.json()) as { code: string };
  const paired = await SELF.fetch('https://sync.test/v1/pair', {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}`, ...json },
    body: JSON.stringify({ code, memberId, deviceId: memberId.replace(/^./, 'e') }),
  });
  expect(paired.status).toBe(200);
  const { secret } = (await paired.json()) as { secret: string };
  return { token: `${owner.hid}.${secret}`, hid: owner.hid, memberId };
}

const destroy = (device: Device) => SELF.fetch('https://sync.test/v1/destroy', {
  method: 'POST', headers: { authorization: `Bearer ${device.token}`, ...json }, body: '{}',
});

async function pull(token: string) {
  const res = await SELF.fetch('https://sync.test/v1/sync?since=0', { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as { seq?: number; records?: unknown[]; code?: string } };
}

async function push(device: Device, id: string) {
  const res = await SELF.fetch('https://sync.test/v1/sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${device.token}`, ...json },
    body: JSON.stringify({ records: [{ id, scope: SCOPE, updatedAt: 1000, device: 'p', nonce: 'nn', body: 'Y2lwaGVy' }] }),
  });
  expect(res.status).toBe(200);
}

/** The platform's own bookkeeping table is not the household's. */
const tables = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) =>
  [...state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")]
    .map((row) => row.name));

describe('POST /v1/destroy', () => {
  it('wipes a household its founder is the last member of: no token opens it and nothing is left', async () => {
    const hid = 'd1'.repeat(16);
    const founder = await claim(hid, 'a1'.repeat(16));
    await push(founder, 'r1');
    expect((await pull(founder.token)).body.records).toHaveLength(1);

    const res = await destroy(founder);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ destroyed: true });
    expect((await pull(founder.token)).status).toBe(401);
    expect(await tables(hid)).toEqual([]);
    expect(await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) => state.storage.getAlarm())).toBeNull();
    // A second ask, with the token that no longer exists, is unauthorised like any other.
    expect((await destroy(founder)).status).toBe(401);
  });

  it('leaves the id to be claimed again from nothing, and never brings an old row back', async () => {
    const hid = 'd2'.repeat(16);
    const founder = await claim(hid, 'a2'.repeat(16));
    await push(founder, 'secret-row');
    await destroy(founder);

    const again = await claim(hid, 'a3'.repeat(16));
    const fresh = await pull(again.token);
    expect(fresh.status).toBe(200);
    expect(fresh.body.records).toEqual([]);
    expect(fresh.body.seq).toBe(0);
    // And the old secret is not the new one.
    expect((await pull(founder.token)).status).toBe(401);
  });

  it('is not the founder leaving: while anyone else is a member, it refuses and changes nothing', async () => {
    const hid = 'd3'.repeat(16);
    const founder = await claim(hid, 'a4'.repeat(16));
    const other = await join(founder, 'b4'.repeat(16));
    await push(founder, 'r1');

    const refused = await destroy(founder);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: 'members_remain' });
    expect((await pull(founder.token)).body.records).toHaveLength(1);
    expect((await pull(other.token)).status).toBe(200);
  });

  it('is the founder’s alone: another member is refused even when they are the last one with a token', async () => {
    const hid = 'd4'.repeat(16);
    const founder = await claim(hid, 'a5'.repeat(16));
    const other = await join(founder, 'b5'.repeat(16));
    const refused = await destroy(other);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'forbidden_primary' });
    expect((await pull(founder.token)).status).toBe(200);
  });

  it('refuses a call without a good token, and touches no other household', async () => {
    const mine = await claim('d5'.repeat(16), 'a6'.repeat(16));
    const theirs = await claim('d6'.repeat(16), 'a7'.repeat(16));
    await push(theirs, 'theirs-1');
    const wrong = await SELF.fetch('https://sync.test/v1/destroy', {
      method: 'POST', headers: { authorization: `Bearer ${mine.hid}.${'0'.repeat(64)}`, ...json }, body: '{}',
    });
    expect(wrong.status).toBe(401);
    expect((await SELF.fetch('https://sync.test/v1/destroy', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
    // A token for a household nobody claimed makes none.
    const nobody = await SELF.fetch('https://sync.test/v1/destroy', {
      method: 'POST', headers: { authorization: `Bearer ${'d7'.repeat(16)}.${'1'.repeat(64)}`, ...json }, body: '{}',
    });
    expect(nobody.status).toBe(401);
    expect(await tables('d7'.repeat(16))).toEqual([]);

    await destroy(mine);
    expect((await pull(theirs.token)).body.records).toHaveLength(1);
  });

  it('is any device’s to ask of a vault, with several of them, and takes the recovery kit with it', async () => {
    const hid = 'd9'.repeat(16);
    const kit = 'c4'.repeat(32);
    const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ scopes: [SCOPE], memberId: 'a9'.repeat(16), deviceId: 'f9'.repeat(16), type: 'personal', recovery: kit }),
    });
    const { secret } = (await res.json()) as { secret: string };
    const first: Device = { token: `${hid}.${secret}`, hid, memberId: 'a9'.repeat(16) };
    // `join` sends another member id; a vault makes the device hers.
    const second = await join(first, 'b9'.repeat(16));
    await push(first, 'r1');

    expect((await destroy(second)).status).toBe(200);
    expect((await pull(first.token)).status).toBe(401);
    expect((await pull(second.token)).status).toBe(401);
    expect(await tables(hid)).toEqual([]);
    const recovered = await SELF.fetch('https://sync.test/v1/recover', {
      method: 'POST', headers: json, body: JSON.stringify({ hid, recovery: kit }),
    });
    expect(recovered.status).toBe(404);
  });

  it('is a POST that says it carries JSON, like the rest', async () => {
    const founder = await claim('d8'.repeat(16), 'a8'.repeat(16));
    const res = await SELF.fetch('https://sync.test/v1/destroy', {
      method: 'POST', headers: { authorization: `Bearer ${founder.token}`, 'content-type': 'text/plain' }, body: '{}',
    });
    expect(res.status).toBe(415);
    expect((await pull(founder.token)).status).toBe(200);
    expect((await SELF.fetch('https://sync.test/v1/destroy', { headers: { authorization: `Bearer ${founder.token}` } })).status).toBe(404);
  });
});
