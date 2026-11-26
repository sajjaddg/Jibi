import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isVaultOnly, KINDS, reservedKind, SHARED_KINDS, type Kind } from '../src/kinds';

/**
 * The golden vectors of the seal (docs/SYNC_PROTOCOL.md § 10), opened and re-made with the
 * WebCrypto the PWA uses. They are the same files the clients' tests are to read, so a byte
 * changed in anybody's seal fails somewhere.
 */

interface Vector {
  name: string; kind: string; scope: string; id: string; aad: string | null;
  key: string; nonce: string; plaintext: string; body: string;
}

const files = import.meta.glob<{ default: Vector }>('./vectors/*.json', { eager: true });
const vectors = Object.values(files).map((file) => file.default);
const FIELDS = ['aad', 'body', 'id', 'key', 'kind', 'name', 'nonce', 'plaintext', 'scope'];

const bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const base64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data)));
const keyOf = (v: Vector) => crypto.subtle.importKey('raw', bytes(v.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
const gcm = (v: Vector, aad = v.aad) => ({
  name: 'AES-GCM', iv: bytes(v.nonce), ...(aad === null ? {} : { additionalData: new TextEncoder().encode(aad) }),
});

describe('the golden vectors', () => {
  it('cover every kind the Worker accepts, and the tombstone', () => {
    expect(new Set(vectors.map((v) => v.kind))).toEqual(new Set(KINDS));
    expect(vectors.map((v) => v.name)).toContain('tombstone');
  });

  it.each(vectors)('$name: carries exactly the agreed fields, its AAD and its id’s namespace', (v) => {
    expect(Object.keys(v).sort()).toEqual(FIELDS);
    expect(v.aad).toBe(v.name === 'legacy' ? null : `mt1|${v.scope}|${v.kind}|${v.id}`);
    if (isVaultOnly(v.kind as Kind)) {
      expect(v.id.startsWith(`${v.kind}:`)).toBe(true);
      expect(v.scope.startsWith('vault:')).toBe(true);
    } else {
      expect(reservedKind(v.id) ?? 'legacy').toBe(v.kind);
    }
    expect(bytes(v.key)).toHaveLength(32);
    expect(bytes(v.nonce)).toHaveLength(12);
  });

  it.each(vectors)('$name: opens to its plaintext, and seals back to the same bytes', async (v) => {
    const key = await keyOf(v);
    const opened = await crypto.subtle.decrypt(gcm(v), key, bytes(v.body));
    expect(new TextDecoder().decode(opened)).toBe(v.plaintext);
    expect(base64(await crypto.subtle.encrypt(gcm(v), key, new TextEncoder().encode(v.plaintext)))).toBe(v.body);
  });

  it.each(vectors.filter((v) => v.aad !== null))('$name: does not open under another id or with no AAD', async (v) => {
    const key = await keyOf(v);
    for (const aad of [`${v.aad}x`, null]) {
      await expect(crypto.subtle.decrypt(gcm(v, aad), key, bytes(v.body))).rejects.toThrow();
    }
  });

  it.each([
    ['family', 'fe', (v: Vector) => (SHARED_KINDS as readonly string[]).includes(v.kind)],
    ['personal', 'fc', () => true],
  ] as const)('are records a %s household takes as they are', async (type, tag, fits) => {
    // The member ids in the vectors are the pusher's: `member`, `transaction` and `asset` are
    // written by their owner only.
    const hid = tag.repeat(16);
    const memberId = '018f0000000070008000000000000001';
    const taken = vectors.filter(fits);
    const claim = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, scopes: [...new Set(taken.map((v) => v.scope))], memberId, deviceId: 'fd'.repeat(16) }),
    });
    const { secret } = (await claim.json()) as { secret: string };
    const records = taken.map((v) => ({
      id: v.id, scope: v.scope, kind: v.kind, updatedAt: 1795000000000, device: 'vectors',
      ownerMemberId: memberId, deleted: v.name === 'tombstone', nonce: v.nonce, body: v.body,
    }));
    const pushed = await SELF.fetch('https://sync.test/v1/sync', {
      method: 'POST', headers: { authorization: `Bearer ${hid}.${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const answer = await pushed.json();
    expect(answer).toMatchObject({ accepted: records.length });
    expect(answer).not.toHaveProperty('rejected');
    expect(pushed.status).toBe(200);
  });
});
