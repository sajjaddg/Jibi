import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { importPublicKeys, verifyEntitlement } from '../../sync/src/entitlement';
import { importSigningKey } from '../src/entitlement';
import { issueEntitlement, slotHash, SLOTS_PER_LICENSE } from '../src/slots';
import vector from './vectors/valid.json';
import { TEST_SIGNING_KEY } from './test-signing-key';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

/** A license signs for two households and renews them for ever after; a third is refused. */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 14, 30);
const slot = (n: number) => n.toString(16).padStart(2, '0').repeat(16);

async function license(id: string, expiresAt: number) {
  await env.DB.prepare(
    "INSERT INTO license (id_hash, plan, expires_at, source, source_ref_hash, created_at) VALUES (?, 'pro', ?, 'test', ?, ?)",
  ).bind(id, expiresAt, `ref-${id}`, NOW).run();
}

const key = () => importSigningKey(TEST_SIGNING_KEY);
const issue = async (id: string, s: string, now = NOW) => issueEntitlement(env.DB, await key(), id, s, now);
const used = async (id: string) =>
  (await env.DB.prepare('SELECT slots_used FROM license WHERE id_hash = ?').bind(id).first<{ slots_used: number }>())!.slots_used;

async function claimsOf(entitlement: string, now = NOW) {
  const verdict = await verifyEntitlement(entitlement, await importPublicKeys(vector.keys[0]), now);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.claims;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM redemption'), env.DB.prepare('DELETE FROM license')]);
});

describe('issuing an entitlement', () => {
  it('signs for two households and refuses a third', async () => {
    expect(SLOTS_PER_LICENSE).toBe(2);
    await license('a', NOW + 30 * DAY);
    for (const n of [1, 2]) expect((await issue('a', slot(n))).ok).toBe(true);
    expect(await issue('a', slot(3))).toEqual({ ok: false, reason: 'no_slots' });
    expect(await used('a')).toBe(2);
  });

  it('renews a household it has signed for without counting it again, with the later end', async () => {
    await license('a', NOW + 30 * DAY);
    await issue('a', slot(1));
    await issue('a', slot(2));
    await env.DB.prepare('UPDATE license SET expires_at = ? WHERE id_hash = ?').bind(NOW + 60 * DAY, 'a').run();
    const renewed = await issue('a', slot(1), NOW + 28 * DAY);
    expect(renewed.ok).toBe(true);
    if (renewed.ok) expect((await claimsOf(renewed.entitlement, NOW + 28 * DAY)).exp).toBe(Date.UTC(2027, 0, 26));
    expect(await used('a')).toBe(2);
  });

  it('puts whole days in it, and nothing about the license', async () => {
    await license('a', NOW + 30 * DAY);
    const got = await issue('a', slot(1));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(await claimsOf(got.entitlement)).toEqual({
      v: 1, plan: 'pro', slot: slot(1), iat: Date.UTC(2026, 10, 26), exp: Date.UTC(2026, 11, 27),
    });
  });

  it('holds to two when five ask at once', async () => {
    await license('a', NOW + 30 * DAY);
    const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => issue('a', slot(n))));
    expect(answers.filter((a) => a.ok)).toHaveLength(2);
    expect(await used('a')).toBe(2);
  });

  it('will not move a household from one license to another', async () => {
    await license('a', NOW + 30 * DAY);
    await license('b', NOW + 30 * DAY);
    await issue('a', slot(1));
    expect(await issue('b', slot(1))).toEqual({ ok: false, reason: 'slot_taken' });
    expect(await used('b')).toBe(0);
  });

  it('signs nothing for a license that is unknown or over', async () => {
    expect(await issue('nobody', slot(1))).toEqual({ ok: false, reason: 'unknown_license' });
    await license('old', NOW - 1);
    expect(await issue('old', slot(1))).toEqual({ ok: false, reason: 'expired' });
    expect(await used('old')).toBe(0);
  });

  it('stores the slot only as a hash under its own label, and the day', async () => {
    await license('a', NOW + 30 * DAY);
    await issue('a', slot(7));
    const rows = (await env.DB.prepare('SELECT * FROM redemption').all()).results;
    expect(rows).toEqual([{ slot_nonce_hash: await slotHash(slot(7)), license_id_hash: 'a', created_at: Date.UTC(2026, 10, 26) }]);
    // The same nonce hashed the way sync/ hashes it is a different value.
    const theirs = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mt1.do-slot|${slot(7)}`));
    expect(await slotHash(slot(7))).not.toBe([...new Uint8Array(theirs)].map((b) => b.toString(16).padStart(2, '0')).join(''));
  });
});
