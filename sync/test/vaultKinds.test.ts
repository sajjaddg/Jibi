import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { KINDS, SHARED_KINDS, VAULT_KINDS } from '../src/kinds';

/**
 * Vault-only kinds: taken by a vault, refused by a family one record at a time, so a bug in a
 * client can neither put a bank message in the family nor stop the family's own records.
 */

const json = { 'content-type': 'application/json' };
const SCOPE = 'scope:v';

let next = 0;
async function claim(type: 'family' | 'personal') {
  next += 1;
  const hid = `5b${next.toString(16).padStart(2, '0')}`.repeat(8);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ type, scopes: [SCOPE] }),
  });
  expect(res.status).toBe(200);
  const { secret } = (await res.json()) as { secret: string };
  return { authorization: `Bearer ${hid}.${secret}`, ...json };
}

const record = (kind: string, id = `${kind}:1`, body = 'Y2lwaGVy') =>
  ({ id, kind, scope: SCOPE, updatedAt: 1000, device: 'p', nonce: 'nn', body });

async function push(auth: Record<string, string>, records: unknown[]) {
  const res = await SELF.fetch('https://sync.test/v1/sync', { method: 'POST', headers: auth, body: JSON.stringify({ records }) });
  return { status: res.status, body: (await res.json()) as { code?: string; accepted?: number; seq?: number; rejected?: { id: string; code: string }[] } };
}

async function stored(auth: Record<string, string>) {
  const res = await SELF.fetch('https://sync.test/v1/sync?since=0&limit=1000', { headers: auth });
  return ((await res.json()) as { records: { id: string; body: string }[] }).records.map((r) => r.id);
}

describe('the vault kinds', () => {
  it('are the ones the plan names, none of them shared', () => {
    expect([...VAULT_KINDS]).toEqual([
      'sms', 'manual_txn', 'anchor', 'rule', 'decision', 'link', 'holding', 'bank', 'loan_person',
      'override', 'day', 'pref', 'entitlement',
    ]);
    expect(KINDS).toHaveLength(SHARED_KINDS.length + VAULT_KINDS.length);
    expect(new Set(KINDS).size).toBe(KINDS.length);
  });

  it('are listed by hello to anyone', async () => {
    const res = await SELF.fetch('https://sync.test/v1/hello');
    expect(((await res.json()) as { kinds: string[] }).kinds).toEqual([...KINDS]);
  });

  it('are all taken by a vault, with category and goal beside them', async () => {
    const auth = await claim('personal');
    const records = [...VAULT_KINDS.map((kind) => record(kind)), record('category', 'category:c'), record('goal', 'goal:g')];
    const res = await push(auth, records);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(records.length);
    expect(res.body).not.toHaveProperty('rejected');
    expect(await stored(auth)).toEqual(records.map((r) => r.id));
  });

  it('are each refused by a family, and the rest of the batch is stored', async () => {
    const auth = await claim('family');
    const res = await push(auth, [
      record('goal', 'goal:before'),
      ...VAULT_KINDS.map((kind) => record(kind)),
      record('note', 'note:after'),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.seq).toBe(2);
    expect(res.body.rejected).toEqual(VAULT_KINDS.map((kind) => ({ id: `${kind}:1`, code: 'kind_not_allowed' })));
    expect(await stored(auth)).toEqual(['goal:before', 'note:after']);
  });

  it('are refused by a family however the id is dressed up', async () => {
    const auth = await claim('family');
    const res = await push(auth, [record('sms', 'goal:sneaky'), record('sms', 'plain')]);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(2);
    expect(await stored(auth)).toEqual([]);
  });

  it('keep to their own namespace in a vault, so two kinds cannot share a row', async () => {
    const auth = await claim('personal');
    for (const id of ['1', 'anchor:1', 'SMS:1']) {
      expect((await push(auth, [record('sms', id)])).body).toEqual({ code: 'invalid_id' });
    }
    expect(await stored(auth)).toEqual([]);
  });

  it('have room for the longest bank message anyone has sent, many times over', async () => {
    const corpus = import.meta.glob<{ default: { cases: { body: string | string[] }[] } }>(
      '../../app/src/test/resources/sms/*.json', { eager: true },
    );
    const bodies = Object.values(corpus).flatMap((file) => (file.default.cases ?? []).map((c) => [c.body].flat().join('\n')));
    const longest = bodies.reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(longest.length).toBeGreaterThan(100);

    // Sealed as a client will: the message among a few fields, plus the 16-byte tag, in base64.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']) as CryptoKey;
    const sealed = async (text: string) => {
      const plain = new TextEncoder().encode(JSON.stringify({ kind: 'sms', sender: '+98999999999', at: 1795000000000, body: text }));
      const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, plain));
      return btoa(String.fromCharCode(...out));
    };
    const auth = await claim('personal');
    // Ten of the longest run together is far past anything a carrier concatenates.
    for (const [n, text] of [longest, longest.repeat(10)].entries()) {
      const body = await sealed(text);
      expect(body.length).toBeLessThan(64 * 1024);
      expect((await push(auth, [record('sms', `sms:${n}`, body)])).status).toBe(200);
    }
  });
});
