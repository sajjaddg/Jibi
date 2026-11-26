import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { importSigningKey, signEntitlement } from '../../billing/src/entitlement';
import { TEST_SIGNING_KEY } from '../../billing/test/test-signing-key';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** `POST /v1/entitlement`: a household takes the plan a genuine entitlement gives, and keeps the longest. */

const json = { 'content-type': 'application/json' };
const DAY = 24 * 60 * 60 * 1000;
const SLOT = '5a'.repeat(16);

let next = 0;
type Body = Record<string, any>;

async function claim(type = 'family') {
  next += 1;
  const hid = `2f${next.toString(16).padStart(2, '0')}`.repeat(8);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ type, scopes: ['family:p'], memberId: 'a1'.repeat(16) }),
  });
  return { hid, token: `${hid}.${((await res.json()) as Body).secret}` };
}

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

const today = () => Math.floor(Date.now() / DAY) * DAY;
const signed = async (exp: number, slot = SLOT) =>
  signEntitlement({ v: 1, plan: 'pro', exp, iat: today(), slot }, await importSigningKey(TEST_SIGNING_KEY));

const give = (token: string, entitlement: unknown) => call(token, '/v1/entitlement', { entitlement });

const meta = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) =>
  Object.fromEntries([...state.storage.sql.exec<{ k: string; v: string }>('SELECT k, v FROM meta')].map((r) => [r.k, r.v])));

describe('POST /v1/entitlement', () => {
  it.each(['family', 'personal'])('makes a %s household Pro, as hello then says', async (type) => {
    const a = await claim(type);
    expect((await call(a.token, '/v1/hello')).body.plan).toBe('free');
    const exp = today() + 31 * DAY;
    expect(await give(a.token, await signed(exp))).toEqual({ status: 200, body: { plan: 'pro', exp } });
    expect((await call(a.token, '/v1/hello')).body.plan).toBe('pro');
  });

  it('keeps the plan, the day it runs out and a hash of the slot, and nothing else of it', async () => {
    const a = await claim();
    const exp = today() + 31 * DAY;
    const token = await signed(exp);
    await give(a.token, token);
    const stored = JSON.parse((await meta(a.hid)).plan);
    expect(Object.keys(stored).sort()).toEqual(['exp', 'plan', 'slot']);
    expect(stored).toMatchObject({ plan: 'pro', exp });
    expect(stored.slot).toMatch(/^[a-f0-9]{64}$/);
    const everything = JSON.stringify(await meta(a.hid));
    for (const part of [SLOT, ...token.split('.')]) expect(everything).not.toContain(part);
  });

  it('keeps whichever runs longest', async () => {
    const a = await claim();
    const [short, long] = [today() + 10 * DAY, today() + 100 * DAY];
    await give(a.token, await signed(long));
    expect((await give(a.token, await signed(short, '6b'.repeat(16)))).body).toEqual({ plan: 'pro', exp: long });
    expect((await give(a.token, await signed(long + DAY))).body.exp).toBe(long + DAY);
  });

  it('raises a family’s member limit at once, for everyone', async () => {
    const a = await claim();
    await runInDurableObject(env.HOUSEHOLD.getByName(a.hid), async (instance) => {
      Object.assign(instance, { metered: () => true });
    });
    const invite = await call(a.token, '/v1/invite', {});
    await call(a.token, '/v1/pair', { code: invite.body.code, memberId: 'b1'.repeat(16) });
    expect((await call(a.token, '/v1/invite', {})).body).toMatchObject({ code: 'quota_exceeded', what: 'members', limit: 2 });
    await give(a.token, await signed(today() + 31 * DAY));
    expect((await call(a.token, '/v1/invite', {})).body.places).toBe(6);
  });

  it('takes one from a read-only member too: it is their money', async () => {
    const a = await claim();
    const { code } = (await call(a.token, '/v1/invite', {})).body;
    const joined = (await call(a.token, '/v1/pair', { code, memberId: 'c1'.repeat(16) })).body;
    await call(a.token, '/v1/role', { member: 'c1'.repeat(16), role: 'readonly' });
    expect((await give(`${a.hid}.${joined.secret}`, await signed(today() + DAY))).status).toBe(200);
  });

  it('counts within the grace and refuses past it', async () => {
    const a = await claim();
    expect((await give(a.token, await signed(today() - 5 * DAY))).body.plan).toBe('pro');
    const b = await claim();
    expect(await give(b.token, await signed(today() - 9 * DAY))).toEqual({ status: 409, body: { code: 'expired_entitlement' } });
    expect((await meta(b.hid)).plan).toBeUndefined();
  });

  it('refuses a forged one, and writes nothing', async () => {
    const a = await claim();
    const real = await signed(today() + DAY);
    const [payload, signature] = real.split('.');
    const forged = btoa(JSON.stringify({ exp: today() + 3650 * DAY, iat: today(), plan: 'pro', slot: SLOT, v: 1 })).replace(/=+$/, '');
    const own = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const selfSigned = await signEntitlement({ v: 1, plan: 'pro', exp: today() + DAY, iat: today(), slot: SLOT }, own.privateKey);
    for (const bad of [`${forged}.${signature}`, `${payload}.${signature.slice(0, -4)}AAAA`, selfSigned, payload, '', 7, null]) {
      expect(await give(a.token, bad), String(bad).slice(0, 20)).toEqual({ status: 400, body: { code: 'invalid_entitlement' } });
    }
    expect((await meta(a.hid)).plan).toBeUndefined();
  });

  it('needs a token of this household', async () => {
    const a = await claim();
    expect((await give(`${a.hid}.${'0'.repeat(64)}`, await signed(today() + DAY))).status).toBe(401);
  });

  it('says the service cannot, not that her purchase is bad, when no key is configured', async () => {
    const a = await claim();
    await runInDurableObject(env.HOUSEHOLD.getByName(a.hid), async (instance) => {
      Object.assign(instance, { env: { ...env, ENTITLEMENT_PUBLIC_KEYS: '' } });
    });
    expect(await give(a.token, await signed(today() + DAY))).toEqual({ status: 503, body: { code: 'unavailable' } });
  });

  // The same entitlement shown to a second household is taken: the server cannot know. What
  // bounds it is billing signing only two slots a license (billing/test/slots.test.ts).
  it('is taken by another household it is shown to', async () => {
    const [a, b] = [await claim(), await claim()];
    const token = await signed(today() + DAY);
    expect((await give(a.token, token)).status).toBe(200);
    expect((await give(b.token, token)).status).toBe(200);
  });

  it('logs nothing', async () => {
    const said: unknown[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args) => { said.push(...args); }));
    const a = await claim();
    await give(a.token, await signed(today() + DAY));
    await give(a.token, 'nonsense.nonsense');
    spies.forEach((spy) => spy.mockRestore());
    expect(said).toEqual([]);
  });
});
