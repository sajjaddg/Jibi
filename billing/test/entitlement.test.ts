import { describe, expect, it } from 'vitest';
import { importPublicKeys, verifyEntitlement } from '../../sync/src/entitlement';
import { importSigningKey, signEntitlement, type Claims } from '../src/entitlement';
import { TEST_SIGNING_KEY } from './test-signing-key';

/**
 * What billing signs is what the golden vectors hold and what `sync/` accepts. The vectors are
 * made by a third implementation (tools/make-entitlement-vectors.mjs), so agreeing with them is
 * agreeing with the contract rather than with ourselves.
 */

interface Vector { name: string; keys: string[]; token: string; now: number; result: string; claims: Claims | null }
const files = import.meta.glob<{ default: Vector }>('./vectors/*.json', { eager: true });
const vectors = Object.fromEntries(Object.values(files).map((f) => [f.default.name, f.default]));

describe('signing', () => {
  it('makes the golden token, byte for byte', async () => {
    const key = await importSigningKey(TEST_SIGNING_KEY);
    expect(await signEntitlement(vectors.valid.claims!, key)).toBe(vectors.valid.token);
    // The keys come out in the agreed order however the object was built.
    const { exp, iat, plan, slot, v } = vectors.valid.claims!;
    expect(await signEntitlement({ v, slot, plan, iat, exp }, key)).toBe(vectors.valid.token);
  });

  it('reads the secret with or without its PEM lines', async () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${TEST_SIGNING_KEY}\n-----END PRIVATE KEY-----\n`;
    expect(await signEntitlement(vectors.valid.claims!, await importSigningKey(pem))).toBe(vectors.valid.token);
  });

  it('makes what sync/ accepts', async () => {
    const claims: Claims = { v: 1, plan: 'pro', exp: Date.UTC(2027, 0, 1), iat: Date.UTC(2026, 10, 26), slot: 'ab'.repeat(16) };
    const token = await signEntitlement(claims, await importSigningKey(TEST_SIGNING_KEY));
    const keys = await importPublicKeys(vectors.valid.keys.join(','));
    expect(await verifyEntitlement(token, keys, claims.iat)).toEqual({ ok: true, claims });
  });

  it('puts nothing in a token but the five claims', async () => {
    const payload = JSON.parse(atob(vectors.valid.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect(Object.keys(payload)).toEqual(['exp', 'iat', 'plan', 'slot', 'v']);
  });
});
