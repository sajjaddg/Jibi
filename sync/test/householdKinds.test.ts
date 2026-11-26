import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { KINDS, SHARED_KINDS } from '../src/kinds';

/** The family's own records (#40, #41): anyone who may write, may write them; the id says which. */

const json = { 'content-type': 'application/json' };
const SCOPE = 'family:h';
const HOUSEHOLD = ['fund', 'fund_entry', 'share_split', 'settlement'];

let next = 0;
async function family() {
  next += 1;
  const hid = `3d${next.toString(16).padStart(2, '0')}`.repeat(8);
  const res = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
    method: 'POST', headers: json, body: JSON.stringify({ scopes: [SCOPE], memberId: 'a1'.repeat(16) }),
  });
  const founder = `${hid}.${((await res.json()) as { secret: string }).secret}`;
  const invite = await SELF.fetch('https://sync.test/v1/invite', { method: 'POST', headers: { authorization: `Bearer ${founder}`, ...json }, body: '{}' });
  const { code } = (await invite.json()) as { code: string };
  const paired = await SELF.fetch('https://sync.test/v1/pair', {
    method: 'POST', headers: { authorization: `Bearer ${founder}`, ...json }, body: JSON.stringify({ code, memberId: 'b1'.repeat(16) }),
  });
  return { founder, other: `${hid}.${((await paired.json()) as { secret: string }).secret}` };
}

async function push(token: string, records: unknown[]) {
  const res = await SELF.fetch('https://sync.test/v1/sync', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify({ records }),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; accepted?: number } };
}

const record = (kind: string, id: string, updatedAt = 1000, deleted = false) =>
  ({ id, kind, scope: SCOPE, updatedAt, device: 'p', ownerMemberId: 'a1'.repeat(16), nonce: 'nn', body: 'YQ==', deleted });

describe.each(HOUSEHOLD)('a %s record', (kind) => {
  it('is accepted in a family and listed by hello', () => {
    expect(SHARED_KINDS as readonly string[]).toContain(kind);
    expect(KINDS as readonly string[]).toContain(kind);
  });

  it('is written, corrected and deleted by any member', async () => {
    const f = await family();
    expect((await push(f.founder, [record(kind, `${kind}:1`)])).body.accepted).toBe(1);
    expect((await push(f.other, [record(kind, `${kind}:1`, 2000)])).status).toBe(200);
    expect((await push(f.other, [record(kind, `${kind}:1`, 3000, true)])).status).toBe(200);
  });

  it('keeps to its namespace, and nothing else takes it', async () => {
    const f = await family();
    expect((await push(f.founder, [record(kind, 'plain')])).body).toEqual({ code: 'invalid_id' });
    expect((await push(f.founder, [record(kind, `goal:1`)])).body).toEqual({ code: 'invalid_kind' });
    expect((await push(f.founder, [record('legacy', `${kind}:1`)])).body).toEqual({ code: 'invalid_kind' });
  });
});
