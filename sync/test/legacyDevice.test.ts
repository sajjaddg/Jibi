import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * A device made before identity has no member id on its row: its member is derived from its token.
 * Removing it, revoking it and protecting it as an admin must go by that derived member (#97).
 */

const json = { 'content-type': 'application/json' };
const SCOPE = 'family:legacy';
type Body = Record<string, any>;

let next = 0;

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** A founder, a plain member, and one whose row is then made as an old Worker left it. */
async function family() {
  next += 1;
  const hid = `1c${next.toString(16).padStart(2, '0')}`.repeat(8);
  const claimed = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId: 'a1'.repeat(16), deviceId: 'a2'.repeat(16) }),
  });
  const founder = `${hid}.${((await claimed.json()) as Body).secret}`;
  const join = async (n: string) => {
    const { code } = (await call(founder, '/v1/invite', {})).body;
    return `${hid}.${(await call(founder, '/v1/pair', { code, memberId: `${n}1`.repeat(16), deviceId: `${n}2`.repeat(16) })).body.secret}`;
  };
  const plain = await join('b');
  const old = await join('c');
  const oldDevice = 'c2'.repeat(16);
  await runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) => {
    state.storage.sql.exec("UPDATE device SET member_id = '', identity_locked = 0 WHERE id = ?", oldDevice);
  });
  // What the server calls it, as `devices` lists it.
  const listed = (await call(founder, '/v1/devices')).body.devices as { memberId: string }[];
  const oldMember = listed.map((d) => d.memberId).find((m) => m !== 'a1'.repeat(16) && m !== 'b1'.repeat(16))!;
  return { hid, founder, plain, old, oldDevice, oldMember };
}

const works = async (token: string) => (await call(token, '/v1/sync?since=0')).status === 200;

const tombstone = (memberId: string) => ({
  id: `member:${memberId}`, scope: SCOPE, kind: 'member', ownerMemberId: memberId, updatedAt: 5000,
  device: 'p', nonce: 'nn', body: 'YQ==', deleted: true,
});

describe('a device older than identity', () => {
  it('is cut off by revoking the member it is listed as', async () => {
    const f = await family();
    expect((await call(f.founder, '/v1/revoke', { member: f.oldMember })).status).toBe(200);
    expect(await works(f.old)).toBe(false);
    expect(await works(f.plain)).toBe(true);
  });

  it('is cut off by removing that member, with no profile needed to be known', async () => {
    const f = await family();
    expect((await call(f.founder, '/v1/remove', { member: f.oldMember, record: tombstone(f.oldMember) })).status).toBe(200);
    expect(await works(f.old)).toBe(false);
  });

  it('made an admin, is as safe from a plain member by its device id as by its member id', async () => {
    const f = await family();
    expect((await call(f.founder, '/v1/role', { member: f.oldMember, role: 'admin' })).status).toBe(200);
    for (const selector of [{ device: f.oldDevice }, { member: f.oldMember }]) {
      expect(await call(f.plain, '/v1/revoke', selector)).toEqual({ status: 403, body: { code: 'forbidden_role' } });
    }
    expect(await works(f.old)).toBe(true);
  });

  it('can still revoke itself, which is leaving', async () => {
    const f = await family();
    await runInDurableObject(env.HOUSEHOLD.getByName(f.hid), async (instance) => {
      Object.assign(instance, { restrictsMembers: () => true });
    });
    expect((await call(f.old, '/v1/revoke', { device: f.oldDevice })).status).toBe(200);
    expect(await works(f.old)).toBe(false);
  });
});
