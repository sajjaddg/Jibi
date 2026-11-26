import { describe, expect, it } from 'vitest';
import { importPublicKeys, verifyEntitlement, type Claims } from '../src/entitlement';

/** The golden vectors of the entitlement, as `sync/` reads them (docs/SYNC_PROTOCOL.md). */

interface Vector { name: string; keys: string[]; token: string; now: number; result: string; claims: Claims | null }
const files = import.meta.glob<{ default: Vector }>('../../billing/test/vectors/*.json', { eager: true });
const vectors = Object.values(files).map((f) => f.default);

describe('the entitlement vectors', () => {
  it('are all here, each with the agreed fields', () => {
    expect(vectors.length).toBe(13);
    for (const v of vectors) expect(Object.keys(v).sort(), v.name).toEqual(['claims', 'keys', 'name', 'now', 'result', 'token']);
  });

  it.each(vectors)('$name: $result', async (v) => {
    const verdict = await verifyEntitlement(v.token, await importPublicKeys(v.keys.join(',')), v.now);
    expect(verdict).toEqual(v.result === 'ok' ? { ok: true, claims: v.claims } : { ok: false, reason: v.result });
  });

  it('are refused with no key at all, and a bad key does not take a good one with it', async () => {
    const valid = vectors.find((v) => v.name === 'valid')!;
    expect(await verifyEntitlement(valid.token, await importPublicKeys(''), valid.now)).toEqual({ ok: false, reason: 'invalid' });
    const mixed = await importPublicKeys(`nonsense, ${valid.keys[0]} ,AAAA`);
    expect(mixed).toHaveLength(1);
    expect((await verifyEntitlement(valid.token, mixed, valid.now)).ok).toBe(true);
  });
});
