import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** A household is her vault or the family, decided at claim: what each one refuses. */

const json = { 'content-type': 'application/json' };
const SCOPE = 'vault:t';
const MEMBER = 'a1'.repeat(16);

let next = 0;
function freshHid(): string {
  next += 1;
  return `7a${next.toString(16).padStart(2, '0')}`.repeat(8);
}

interface Device { token: string; hid: string; memberId: string; deviceId: string }

function post(path: string, token: string, body: unknown) {
  return SELF.fetch(`https://sync.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body),
  });
}

function claimAs(hid: string, type?: unknown) {
  return SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ scopes: [SCOPE], memberId: MEMBER, deviceId: 'd1'.repeat(16), type }),
  });
}

async function claim(type?: string): Promise<Device> {
  const hid = freshHid();
  const res = await claimAs(hid, type);
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { token: `${hid}.${secret}`, hid, memberId: MEMBER, deviceId: 'd1'.repeat(16) };
}

async function join(owner: Device, memberId: string, deviceId: string) {
  const { code } = (await (await post('/v1/invite', owner.token, {})).json()) as { code: string };
  const res = await post('/v1/pair', owner.token, { code, memberId, deviceId });
  const body = (await res.json()) as { secret: string; memberId: string; deviceId: string; code?: string };
  return { status: res.status, body, device: { token: `${owner.hid}.${body.secret}`, hid: owner.hid, memberId: body.memberId, deviceId } };
}

const status = async (res: Response) => [res.status, ((await res.json()) as { code?: string }).code];

const meta = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) =>
  Object.fromEntries([...state.storage.sql.exec<{ k: string; v: string }>('SELECT k, v FROM meta')].map((r) => [r.k, r.v])));

const devices = async (device: Device) => {
  const res = await SELF.fetch('https://sync.test/v1/devices', { headers: { authorization: `Bearer ${device.token}` } });
  return ((await res.json()) as { devices: { memberId: string }[] }).devices;
};

describe('claiming', () => {
  it('makes a family unless it is told otherwise, and writes down only that it is a vault', async () => {
    expect(await meta((await claim()).hid)).not.toHaveProperty('type');
    expect(await meta((await claim('family')).hid)).not.toHaveProperty('type');
    expect((await meta((await claim('personal')).hid)).type).toBe('personal');
  });

  it('refuses a type it does not know, and leaves the id unclaimed', async () => {
    const hid = freshHid();
    for (const type of ['vault', '', 1, {}]) expect(await status(await claimAs(hid, type))).toEqual([400, 'invalid_type']);
    expect((await claimAs(hid, 'personal')).status).toBe(200);
  });

  it('cannot be turned from one into the other by claiming again', async () => {
    const vault = await claim('personal');
    expect(await status(await claimAs(vault.hid, 'family'))).toEqual([409, 'already_claimed']);
    expect((await meta(vault.hid)).type).toBe('personal');
  });
});

describe('a vault', () => {
  it('takes her next device as her own, whatever member it says it is', async () => {
    const vault = await claim('personal');
    const joined = await join(vault, 'b2'.repeat(16), 'd2'.repeat(16));
    expect(joined.status).toBe(200);
    expect(joined.body.memberId).toBe(MEMBER);
    expect(new Set((await devices(vault)).map((d) => d.memberId))).toEqual(new Set([MEMBER]));
    // A device id somebody already has is still refused.
    expect((await join(vault, MEMBER, 'd2'.repeat(16))).body.code).toBe('identity_exists');
  });

  it('cannot gain a second member through identity', async () => {
    const vault = await claim('personal');
    const res = await post('/v1/identity', vault.token, { memberId: 'b3'.repeat(16), deviceId: vault.deviceId });
    expect(await status(res)).toEqual([409, 'identity_locked']);
  });

  it('has no member to remove or to leave as', async () => {
    const vault = await claim('personal');
    const tombstone = {
      id: `member:${MEMBER}`, scope: SCOPE, kind: 'member', ownerMemberId: MEMBER, updatedAt: 1, device: 'p',
      nonce: 'nn', body: 'YQ==', deleted: true,
    };
    expect(await status(await post('/v1/leave', vault.token, { record: tombstone }))).toEqual([403, 'forbidden_type']);
    expect(await status(await post('/v1/remove', vault.token, { member: 'b4'.repeat(16), record: tombstone }))).toEqual([403, 'forbidden_type']);
    expect(await status(await post('/v1/revoke', vault.token, { member: MEMBER }))).toEqual([403, 'forbidden_type']);
    expect(await devices(vault)).toHaveLength(1);
  });

  it('lets a lost device be revoked, and never the last one', async () => {
    const vault = await claim('personal');
    const second = (await join(vault, MEMBER, 'd5'.repeat(16))).device;
    expect((await post('/v1/revoke', second.token, { device: vault.deviceId })).status).toBe(200);
    expect((await SELF.fetch('https://sync.test/v1/devices', { headers: { authorization: `Bearer ${vault.token}` } })).status).toBe(401);

    expect(await status(await post('/v1/revoke', second.token, { device: second.deviceId }))).toEqual([409, 'last_device']);
    expect(await devices(second)).toHaveLength(1);
    // The vault and what it holds are still there.
    expect((await meta(vault.hid)).type).toBe('personal');
  });

  it('is a family’s rules that a family still has', async () => {
    const family = await claim();
    expect((await post('/v1/revoke', family.token, { device: family.deviceId })).status).toBe(200);
    // Its last device gone, the family is wiped and the id is free again.
    expect((await claimAs(family.hid)).status).toBe(200);
  });
});
