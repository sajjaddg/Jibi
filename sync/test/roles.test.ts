import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { effectiveRoles, ROLES_RESTRICT_MEMBERS } from '../src/roles';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Admin, member, read-only: each role against each call, enforced by the server. The restriction
 * on plain members ships switched off, so both states of it are walked.
 */

const json = { 'content-type': 'application/json' };
const SCOPE = 'family:roles';
const ids = { founder: 'a1'.repeat(16), second: 'b1'.repeat(16), third: 'c1'.repeat(16) };

let next = 0;
interface Person { token: string; memberId: string; deviceId: string }
type Body = Record<string, any>;

async function call(person: Person, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${person.token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${person.token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function family() {
  next += 1;
  const hid = `6c${next.toString(16).padStart(2, '0')}`.repeat(8);
  const claimed = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId: ids.founder, deviceId: 'a2'.repeat(16) }),
  });
  const founder: Person = { token: `${hid}.${((await claimed.json()) as Body).secret}`, memberId: ids.founder, deviceId: 'a2'.repeat(16) };
  const join = async (memberId: string): Promise<Person> => {
    const { code } = (await call(founder, '/v1/invite', {})).body;
    const deviceId = memberId.replace(/1/g, '2');
    const { body } = await call(founder, '/v1/pair', { code, memberId, deviceId });
    return { token: `${hid}.${body.secret}`, memberId, deviceId };
  };
  const second = await join(ids.second);
  const third = await join(ids.third);
  return { hid, founder, second, third, join };
}

const restrict = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (instance) => {
  Object.assign(instance, { restrictsMembers: () => true });
});

const setRole = (by: Person, member: string, role: string) => call(by, '/v1/role', { member, role });

const tombstone = (memberId: string) => ({
  id: `member:${memberId}`, scope: SCOPE, kind: 'member', ownerMemberId: memberId, updatedAt: 5000,
  device: 'p', nonce: 'nn', body: 'YQ==', deleted: true,
});

const record = (id: string, over: Body = {}) => ({ id, scope: SCOPE, updatedAt: 1000, device: 'p', nonce: 'nn', body: 'YQ==', ...over });

const forbidden = { status: 403, body: { code: 'forbidden_role' } };

describe('who is what', () => {
  const rows = (...pairs: [string, string][]) => pairs.map(([memberId, role]) => ({ memberId, role }));
  const roles = (founder: string, ...pairs: [string, string][]) => Object.fromEntries(effectiveRoles(rows(...pairs), founder));

  it('is the founder as admin and everyone else a member until somebody says', () => {
    expect(roles('f', ['f', ''], ['a', ''])).toEqual({ f: 'admin', a: 'member' });
    expect(roles('f', ['f', 'readonly'], ['a', 'admin'])).toEqual({ f: 'admin', a: 'admin' });
  });

  it('is never nobody: with the founder gone, the longest-standing who is not read-only', () => {
    expect(roles('f', ['a', 'readonly'], ['b', ''], ['c', ''])).toEqual({ a: 'readonly', b: 'admin', c: 'member' });
    expect(roles('f', ['a', ''], ['b', 'admin'])).toEqual({ a: 'member', b: 'admin' });
    expect(roles('f', ['a', 'readonly'], ['b', 'readonly'])).toEqual({ a: 'admin', b: 'readonly' });
    expect(roles('f')).toEqual({});
  });

  it('is told to anyone in the family', async () => {
    const f = await family();
    expect((await setRole(f.founder, ids.third, 'readonly')).status).toBe(200);
    expect((await call(f.third, '/v1/roles')).body).toEqual({
      role: 'readonly',
      members: [
        { memberId: ids.founder, role: 'admin' },
        { memberId: ids.second, role: 'member' },
        { memberId: ids.third, role: 'readonly' },
      ],
    });
  });
});

describe('as shipped', () => {
  it('lets a plain member invite and remove, as every released client does', async () => {
    expect(ROLES_RESTRICT_MEMBERS).toBe(false);
    const f = await family();
    expect((await call(f.second, '/v1/invite', {})).status).toBe(200);
    expect((await call(f.second, '/v1/remove', { member: ids.third, record: tombstone(ids.third) })).status).toBe(200);
  });

  it('still keeps a member away from an admin, and from roles', async () => {
    const f = await family();
    await setRole(f.founder, ids.third, 'admin');
    expect(await call(f.second, '/v1/remove', { member: ids.third, record: tombstone(ids.third) })).toEqual(forbidden);
    expect(await call(f.second, '/v1/revoke', { member: ids.third })).toEqual(forbidden);
    expect(await call(f.second, '/v1/revoke', { device: f.third.deviceId })).toEqual(forbidden);
    expect(await setRole(f.second, ids.second, 'admin')).toEqual(forbidden);
    expect((await call(f.third, '/v1/sync?since=0')).status).toBe(200);
  });

  it('still holds a read-only member to read-only', async () => {
    const f = await family();
    await setRole(f.founder, ids.third, 'readonly');
    expect(await call(f.third, '/v1/invite', {})).toEqual(forbidden);
    expect(await call(f.third, '/v1/remove', { member: ids.second, record: tombstone(ids.second) })).toEqual(forbidden);
    expect(await call(f.third, '/v1/revoke', { member: ids.second })).toEqual(forbidden);
  });
});

describe('with members restricted', () => {
  it('walks every role against every call', async () => {
    const table: [string, (who: Person, other: Person) => Promise<{ status: number; body: Body }>, Record<string, number>][] = [
      ['pull', (who) => call(who, '/v1/sync?since=0'), { admin: 200, member: 200, readonly: 200 }],
      ['hello', (who) => call(who, '/v1/hello'), { admin: 200, member: 200, readonly: 200 }],
      ['devices', (who) => call(who, '/v1/devices'), { admin: 200, member: 200, readonly: 200 }],
      ['roles', (who) => call(who, '/v1/roles'), { admin: 200, member: 200, readonly: 200 }],
      ['push', (who) => call(who, '/v1/sync', { records: [record('note:x', { kind: 'note' })] }), { admin: 200, member: 200, readonly: 200 }],
      ['invite', (who) => call(who, '/v1/invite', {}), { admin: 200, member: 403, readonly: 403 }],
      ['remove', (who, other) => call(who, '/v1/remove', { member: other.memberId, record: tombstone(other.memberId) }), { admin: 200, member: 403, readonly: 403 }],
      ['revoke another', (who, other) => call(who, '/v1/revoke', { member: other.memberId }), { admin: 200, member: 403, readonly: 403 }],
      ['role', (who, other) => setRole(who, other.memberId, 'readonly'), { admin: 200, member: 403, readonly: 403 }],
      ['rotate', (who) => call(who, '/v1/rotate', {}), { admin: 200, member: 200, readonly: 200 }],
      ['leave', (who) => call(who, '/v1/leave', { record: tombstone(who.memberId) }), { admin: 200, member: 200, readonly: 200 }],
      ['revoke self', (who) => call(who, '/v1/revoke', { member: who.memberId }), { admin: 200, member: 200, readonly: 200 }],
    ];
    for (const [name, act, expected] of table) {
      for (const role of ['admin', 'member', 'readonly'] as const) {
        const f = await family();
        await restrict(f.hid);
        expect((await setRole(f.founder, ids.second, role)).status).toBe(200);
        const res = await act(f.second, f.third);
        expect(res.status, `${role}: ${name} ${JSON.stringify(res.body)}`).toBe(expected[role]);
      }
    }
  }, 60_000);

  it('stops a tampered client of a plain member from putting anybody out', async () => {
    const f = await family();
    await restrict(f.hid);
    expect(await call(f.second, '/v1/remove', { member: ids.third, record: tombstone(ids.third) })).toEqual(forbidden);
    expect(await call(f.second, '/v1/revoke', { member: ids.third })).toEqual(forbidden);
    expect(await call(f.second, '/v1/revoke', { device: f.third.deviceId })).toEqual(forbidden);
    expect((await call(f.third, '/v1/sync?since=0')).status).toBe(200);
  });
});

describe('revoking one’s own device', () => {
  it('is leaving, even for a token that predates member ids', async () => {
    const f = await family();
    await restrict(f.hid);
    await runInDurableObject(env.HOUSEHOLD.getByName(f.hid), async (_instance, state) => {
      state.storage.sql.exec("UPDATE device SET member_id = '' WHERE id = ?", f.second.deviceId);
    });
    expect((await call(f.second, '/v1/revoke', { device: f.second.deviceId })).status).toBe(200);
  });
});

describe('a read-only push', () => {
  it('stores nothing new, and still lets them take back what is theirs', async () => {
    const f = await family();
    const mine = `txn:${ids.third}:1`;
    await call(f.third, '/v1/sync', { records: [record(mine, { kind: 'transaction', ownerMemberId: ids.third })] });
    await setRole(f.founder, ids.third, 'readonly');

    const res = await call(f.third, '/v1/sync', {
      records: [
        record(`txn:${ids.third}:2`, { kind: 'transaction', ownerMemberId: ids.third }),
        record('goal:g', { kind: 'goal' }),
        record('note:n', { kind: 'note' }),
        record(`member:${ids.third}`, { kind: 'member', ownerMemberId: ids.third }),
        record('goal:g2', { kind: 'goal', deleted: true }),
        record(mine, { kind: 'transaction', ownerMemberId: ids.third, updatedAt: 2000, deleted: true }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected.map((r: Body) => [r.id, r.code])).toEqual([
      [`txn:${ids.third}:2`, 'read_only'], ['goal:g', 'read_only'], ['note:n', 'read_only'],
      [`member:${ids.third}`, 'read_only'], ['goal:g2', 'read_only'],
    ]);
    const stored = (await call(f.founder, '/v1/sync?since=0')).body.records as Body[];
    expect(stored.map((r) => [r.id, r.deleted])).toEqual([[mine, true]]);
  });

  it('cannot take back somebody else’s row by naming itself its owner', async () => {
    const f = await family();
    const theirs = `txn:${ids.second}:1`;
    await call(f.second, '/v1/sync', { records: [record(theirs, { kind: 'transaction', ownerMemberId: ids.second })] });
    await setRole(f.founder, ids.third, 'readonly');
    const res = await call(f.third, '/v1/sync', {
      records: [record(theirs, { kind: 'transaction', ownerMemberId: ids.third, updatedAt: 2000, deleted: true })],
    });
    expect(res).toEqual({ status: 403, body: { code: 'forbidden_owner' } });
  });
});

describe('POST /v1/role', () => {
  it('keeps the founder an admin, and refuses what it does not know', async () => {
    const f = await family();
    await setRole(f.founder, ids.second, 'admin');
    expect(await setRole(f.second, ids.founder, 'member')).toEqual({ status: 403, body: { code: 'forbidden_primary' } });
    expect(await setRole(f.founder, ids.second, 'owner')).toEqual({ status: 400, body: { code: 'invalid_role' } });
    expect(await setRole(f.founder, 'ff'.repeat(16), 'admin')).toEqual({ status: 404, body: { code: 'unknown_member' } });
    expect((await setRole(f.founder, ids.second, 'member')).status).toBe(200);
  });

  it('never leaves the family without an admin', async () => {
    const f = await family();
    await setRole(f.founder, ids.second, 'admin');
    expect((await call(f.founder, '/v1/leave', { record: tombstone(ids.founder) })).status).toBe(200);
    expect(await setRole(f.second, ids.second, 'member')).toEqual({ status: 409, body: { code: 'last_admin' } });
    // With another named first, stepping down is fine.
    expect((await setRole(f.second, ids.third, 'admin')).status).toBe(200);
    expect((await setRole(f.second, ids.second, 'member')).status).toBe(200);
  });

  it('lets whoever is left run the family, down to destroying it', async () => {
    const f = await family();
    await restrict(f.hid);
    expect((await call(f.founder, '/v1/leave', { record: tombstone(ids.founder) })).status).toBe(200);
    expect((await call(f.second, '/v1/invite', {})).status).toBe(200);
    expect((await call(f.third, '/v1/revoke', { member: ids.third })).status).toBe(200);
    expect(await call(f.second, '/v1/destroy', {})).toEqual({ status: 200, body: { destroyed: true } });
  });

  it('drops the codes shown before it, and is not for a vault', async () => {
    const f = await family();
    const { code } = (await call(f.second, '/v1/invite', {})).body;
    await setRole(f.founder, ids.second, 'readonly');
    expect((await call(f.founder, '/v1/pair', { code, memberId: 'd1'.repeat(16), deviceId: 'd2'.repeat(16) })).body).toEqual({ code: 'invalid_code' });

    const hid = '6d'.repeat(16);
    const claimed = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
      method: 'POST', headers: json, body: JSON.stringify({ type: 'personal', scopes: [SCOPE], memberId: ids.founder }),
    });
    const vault = { token: `${hid}.${((await claimed.json()) as Body).secret}`, memberId: ids.founder, deviceId: '' };
    expect((await setRole(vault, ids.founder, 'admin')).body).toEqual({ code: 'forbidden_type' });
    expect((await call(vault, '/v1/roles')).body).toEqual({ code: 'forbidden_type' });
    expect((await call(vault, '/v1/invite', {})).status).toBe(200);
  });
});
