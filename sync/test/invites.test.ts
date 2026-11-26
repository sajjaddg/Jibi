import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** Invitations: how long one lasts, how many places are left, and an admin taking one back. */

const json = { 'content-type': 'application/json' };
const SCOPE = 'family:i';
const MINUTE = 60 * 1000;

let next = 0;
type Body = Record<string, any>;

async function claim(type = 'family') {
  next += 1;
  const hid = `5e${next.toString(16).padStart(2, '0')}`.repeat(8);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ type, scopes: [SCOPE], memberId: 'a1'.repeat(16) }),
  });
  return { hid, token: `${hid}.${((await res.json()) as Body).secret}` };
}

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

const expiries = async (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) =>
  [...state.storage.sql.exec<{ expires_at: number }>('SELECT expires_at FROM pairing')].map((r) => r.expires_at - Date.now()));

describe('an invitation', () => {
  it('lasts ten minutes unless a day is asked for, and nothing else', async () => {
    const a = await claim();
    expect((await call(a.token, '/v1/invite', {})).body.expiresIn).toBe(10 * MINUTE);
    expect((await call(a.token, '/v1/invite', { expiresIn: 24 * 60 * MINUTE })).body.expiresIn).toBe(24 * 60 * MINUTE);
    const [short, long] = (await expiries(a.hid)).sort((x, y) => x - y);
    expect(short).toBeLessThanOrEqual(10 * MINUTE);
    expect(long).toBeGreaterThan(23 * 60 * MINUTE);
    for (const expiresIn of [0, 1, 11 * MINUTE, '600000', 7 * 24 * 60 * MINUTE]) {
      expect(await call(a.token, '/v1/invite', { expiresIn })).toEqual({ status: 400, body: { code: 'invalid_expiry' } });
    }
  });

  it('says how many places are left', async () => {
    const a = await claim();
    expect((await call(a.token, '/v1/invite', {})).body.places).toBe(15);
    await runInDurableObject(env.HOUSEHOLD.getByName(a.hid), async (instance) => {
      Object.assign(instance, { metered: () => true });
    });
    // A free family of one has room for one more person.
    expect((await call(a.token, '/v1/invite', {})).body.places).toBe(1);
  });

  it('can be listed and cancelled by an admin, and then redeems nothing', async () => {
    const a = await claim();
    const { code } = (await call(a.token, '/v1/invite', {})).body;
    const listed = (await call(a.token, '/v1/invites')).body.invites as Body[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(['expiresAt', 'id']);
    // What names a code cannot be used as one.
    expect(listed[0].id).not.toBe(code);
    expect((await call(a.token, '/v1/pair', { code: listed[0].id })).body).toEqual({ code: 'invalid_code' });

    expect(await call(a.token, '/v1/invites/cancel', { id: listed[0].id })).toEqual({ status: 200, body: { cancelled: true } });
    expect(await call(a.token, '/v1/pair', { code })).toEqual({ status: 403, body: { code: 'invalid_code' } });
    expect((await call(a.token, '/v1/invites')).body.invites).toEqual([]);
    expect(await call(a.token, '/v1/invites/cancel', { id: listed[0].id })).toEqual({ status: 404, body: { code: 'unknown_invite' } });
  });

  it('leaves an expired code off the list', async () => {
    const a = await claim();
    await call(a.token, '/v1/invite', {});
    await runInDurableObject(env.HOUSEHOLD.getByName(a.hid), async (_i, state) => {
      state.storage.sql.exec('UPDATE pairing SET expires_at = 1');
    });
    expect((await call(a.token, '/v1/invites')).body.invites).toEqual([]);
  });

  it('is an admin’s to list and cancel, whatever a plain member may still do', async () => {
    const a = await claim();
    const { code } = (await call(a.token, '/v1/invite', {})).body;
    const joined = (await call(a.token, '/v1/pair', { code, memberId: 'b1'.repeat(16) })).body;
    const member = `${a.hid}.${joined.secret}`;
    expect(await call(member, '/v1/invites')).toEqual({ status: 403, body: { code: 'forbidden_role' } });
    expect(await call(member, '/v1/invites/cancel', { id: 'x' })).toEqual({ status: 403, body: { code: 'forbidden_role' } });
    expect((await call(`${a.hid}.${'0'.repeat(64)}`, '/v1/invites')).status).toBe(401);
    // And hers in a vault, where she is the one member.
    const vault = await claim('personal');
    expect((await call(vault.token, '/v1/invites')).status).toBe(200);
  });
});
