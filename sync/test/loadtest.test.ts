import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHAPE, generateVault, weigh } from '../loadtest/vault.mjs';

/**
 * The generator behind `pnpm run loadtest`. A load test is only worth reading if the vault it
 * pushes is the same every time and is one this server accepts, so both are checked here — the
 * second by pushing a small vault through the real Worker.
 */

const NOW = Date.UTC(2026, 10, 26);

describe('the synthetic vault', () => {
  it('is five years of one person: the shape docs/backend-plan.md names', () => {
    const records = generateVault({ now: NOW });
    expect(records).toHaveLength(DEFAULT_SHAPE.sms + DEFAULT_SHAPE.decisions + DEFAULT_SHAPE.goals + DEFAULT_SHAPE.days);
    const by = (prefix: string) => records.filter((r) => r.id.startsWith(prefix)).length;
    expect(by('sms:')).toBe(30_000);
    expect(by('decision:')).toBe(10_000);
    expect(by('goal:')).toBe(100);
    expect(by('day:')).toBe(1825);
  });

  it('is the same vault for the same seed and a different one for another', () => {
    const a = generateVault({ seed: 7, scale: 0.01, now: NOW });
    expect(generateVault({ seed: 7, scale: 0.01, now: NOW })).toEqual(a);
    expect(generateVault({ seed: 8, scale: 0.01, now: NOW })).not.toEqual(a);
  });

  it('keeps every id unique and every field inside the server’s limits, with no stamp from the future', () => {
    const records = generateVault({ scale: 0.05, now: NOW });
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    for (const r of records) {
      expect(r.id.length).toBeLessThanOrEqual(256);
      expect(r.scope.length).toBeLessThanOrEqual(128);
      expect(r.device.length).toBeLessThanOrEqual(64);
      expect(r.nonce.length).toBeLessThanOrEqual(64);
      expect(r.body.length).toBeLessThanOrEqual(64 * 1024);
      expect(Number.isSafeInteger(r.updatedAt)).toBe(true);
      expect(r.updatedAt).toBeLessThanOrEqual(NOW);
      expect(r.updatedAt).toBeGreaterThan(NOW - 1826 * 24 * 60 * 60 * 1000);
    }
  });

  it('weighs what the full vault is expected to: tens of megabytes of ciphertext, under the 256 MB cap', () => {
    const { records, bodyBytes } = weigh(generateVault({ now: NOW }));
    expect(records).toBe(41_925);
    expect(bodyBytes).toBeGreaterThan(15 * 1024 * 1024);
    expect(bodyBytes).toBeLessThan(32 * 1024 * 1024);
  });

  it('is accepted by the server whole, and comes back the same through the ordinary pull', async () => {
    const hid = 'f0'.repeat(16);
    const claim = await SELF.fetch(`https://sync.test/v1/claim?hid=${hid}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopes: ['vault:load'] }),
    });
    const { secret } = (await claim.json()) as { secret: string };
    const auth = { authorization: `Bearer ${hid}.${secret}`, 'content-type': 'application/json' };
    const records = generateVault({ scale: 0.02, now: Date.now() });
    for (let at = 0; at < records.length; at += 500) {
      const res = await SELF.fetch('https://sync.test/v1/sync', { method: 'POST', headers: auth, body: JSON.stringify({ records: records.slice(at, at + 500) }) });
      expect(res.status).toBe(200);
    }
    const ids: string[] = [];
    for (let since = 0;;) {
      const res = await SELF.fetch(`https://sync.test/v1/sync?since=${since}&limit=1000`, { headers: auth });
      const page = (await res.json()) as { seq: number; hasMore: boolean; records: { id: string }[] };
      ids.push(...page.records.map((r) => r.id));
      since = page.seq;
      if (!page.hasMore) break;
    }
    expect(ids.sort()).toEqual(records.map((r) => r.id).sort());
  });
});
