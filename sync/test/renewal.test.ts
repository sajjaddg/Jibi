import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/**
 * Removing a member and renewing the family key, with everyone also keeping a vault (#43). What
 * the clients do (`renewHousehold`) is claim a fresh household under the same member and device
 * ids with a new key, and have the others join it. What must hold: the person removed reads
 * nothing written afterwards, and nobody's vault is touched.
 */

const json = { 'content-type': 'application/json' };
type Body = Record<string, any>;

const member = (n: number) => `${n}1`.repeat(16);
const device = (n: number) => `${n}2`.repeat(16);

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await SELF.fetch(`https://sync.test${path}`, body === undefined
    ? { headers: { authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function claim(hid: string, type: string, n: number, scope: string) {
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ type, scopes: [scope], memberId: member(n), deviceId: device(n) }),
  });
  expect(res.status).toBe(200);
  return `${hid}.${((await res.json()) as Body).secret}`;
}

async function join(owner: string, n: number) {
  const { code } = (await call(owner, '/v1/invite', {})).body;
  const paired = await call(owner, '/v1/pair', { code, memberId: member(n), deviceId: device(n) });
  expect(paired.status).toBe(200);
  return `${owner.split('.')[0]}.${paired.body.secret}`;
}

/** A record as a client seals it, under the scope's own key and bound to its name. */
async function sealed(key: CryptoKey, scope: string, kind: string, id: string, text: string, ownerMemberId = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`mt1|${scope}|${kind}|${id}`);
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(text));
  const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return { id, kind, scope, ownerMemberId, updatedAt: Date.now(), device: 'p', nonce: base64(iv), body: base64(body) };
}

async function opens(key: CryptoKey, record: Body) {
  const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const additionalData = new TextEncoder().encode(`mt1|${record.scope}|${record.kind}|${record.id}`);
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(record.nonce), additionalData }, key, bytes(record.body));
    return true;
  } catch {
    return false;
  }
}

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;

/** Everything an object holds that is hers: records, devices and meta, as stored. */
const dump = (hid: string) => runInDurableObject(env.HOUSEHOLD.getByName(hid), async (_i, state) => ({
  records: [...state.storage.sql.exec('SELECT * FROM record ORDER BY id')],
  devices: [...state.storage.sql.exec('SELECT id, member_id, token_hash, scopes, added_at, role FROM device ORDER BY id')],
  meta: [...state.storage.sql.exec('SELECT * FROM meta ORDER BY k')],
}));

describe('removing a member and renewing the key', () => {
  it('shuts the removed member out of everything written afterwards, and leaves every vault whole', async () => {
    const [family, renewed] = ['8a'.repeat(16), '8b'.repeat(16)];
    const vaults = ['8c'.repeat(16), '8d'.repeat(16), '8e'.repeat(16)];
    const [oldScope, newScope] = [`family:${family}`, `family:${renewed}`];
    const oldKey = await newKey();
    const freshKey = await newKey();

    // Three people, each with a vault of their own and a place in the family.
    const vaultTokens: string[] = [];
    for (const [i, hid] of vaults.entries()) {
      const token = await claim(hid, 'personal', i + 3, `vault:${hid}`);
      const key = await newKey();
      expect((await call(token, '/v1/sync', { records: [await sealed(key, `vault:${hid}`, 'sms', 'sms:1', 'پیامک')] })).status).toBe(200);
      vaultTokens.push(token);
    }
    const founder = await claim(family, 'family', 3, oldScope);
    const stays = await join(founder, 4);
    const removed = await join(founder, 5);
    const before = await sealed(oldKey, oldScope, 'transaction', `txn:${member(3)}:1`, 'قدیمی', member(3));
    expect((await call(founder, '/v1/sync', { records: [before] })).status).toBe(200);
    expect((await call(removed, '/v1/sync?since=0')).body.records).toHaveLength(1);
    const kept = (await call(removed, '/v1/invite', {})).body.code;
    const vaultsBefore = await Promise.all(vaults.map(dump));

    // Removed, then renewed: a new household, a new key, and the one who stays joins it.
    const tombstone = {
      ...(await sealed(oldKey, oldScope, 'member', `member:${member(5)}`, 'x', member(5))), deleted: true,
    };
    expect((await call(founder, '/v1/remove', { member: member(5), record: tombstone })).status).toBe(200);
    const founderNew = await claim(renewed, 'family', 3, newScope);
    const staysNew = await join(founderNew, 4);
    const after = await sealed(freshKey, newScope, 'transaction', `txn:${member(3)}:2`, 'تازه', member(3));
    expect((await call(founderNew, '/v1/sync', { records: [after] })).status).toBe(200);

    // The old token opens neither household, and neither does its secret aimed at the new one.
    const secret = removed.split('.')[1];
    for (const token of [removed, `${renewed}.${secret}`]) {
      expect((await call(token, '/v1/sync?since=0')).status).toBe(401);
      expect((await call(token, '/v1/devices')).status).toBe(401);
      expect((await call(token, '/v1/sync', { records: [after] })).status).toBe(401);
    }
    // A code they minted before leaving was swept with them.
    expect((await call(founder, '/v1/pair', { code: kept })).body).toEqual({ code: 'invalid_code' });

    // Even with the new ciphertext in hand, the key they hold opens none of it.
    const pulled = (await call(staysNew, '/v1/sync?since=0')).body.records as Body[];
    expect(pulled.map((r) => r.id)).toEqual([after.id]);
    expect(await opens(oldKey, pulled[0])).toBe(false);
    expect(await opens(freshKey, pulled[0])).toBe(true);
    // And nothing new reached the household they were in.
    expect(((await call(stays, '/v1/sync?since=0')).body.records as Body[]).map((r) => r.id)).not.toContain(after.id);

    // Every vault, the removed member's among them, is byte for byte what it was and still opens.
    expect(await Promise.all(vaults.map(dump))).toEqual(vaultsBefore);
    for (const token of vaultTokens) expect((await call(token, '/v1/sync?since=0')).body.records).toHaveLength(1);
  });
});
