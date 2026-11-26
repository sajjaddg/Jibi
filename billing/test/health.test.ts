import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import config from '../wrangler.jsonc?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

describe('billing', () => {
  it('answers its health check with the database behind it', async () => {
    const res = await SELF.fetch('https://pay.test/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('knows no other call yet', async () => {
    for (const [method, path] of [['GET', '/'], ['POST', '/v1/health'], ['GET', '/v1/license']]) {
      const res = await SELF.fetch(`https://pay.test${path}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'not_found' });
    }
  });

  it('is limited per address', async () => {
    const into = Date.now() % 60_000;
    if (into > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 100));
    const from = () => SELF.fetch('https://pay.test/v1/health', { headers: { 'cf-connecting-ip': '203.0.113.30' } });
    for (let i = 0; i < 60; i++) expect((await from()).status).toBe(200);
    const limited = await from();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  }, 30_000);

  it('answers 500 and logs the error alone when the database is gone', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(line); });
    await env.DB.prepare('ALTER TABLE license RENAME TO license_gone').run();
    const res = await SELF.fetch('https://pay.test/v1/health?key=do-not-log-me');
    await env.DB.prepare('ALTER TABLE license_gone RENAME TO license').run();
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'internal' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('do-not-log-me');
  });
});

describe('what it keeps', () => {
  it('is licenses and redemptions, with nothing that names a person or a household', async () => {
    expect(await columns('license')).toEqual(['id_hash', 'plan', 'expires_at', 'source', 'source_ref_hash', 'slots_used', 'created_at']);
    expect(await columns('redemption')).toEqual(['slot_nonce_hash', 'license_id_hash', 'created_at']);
  });

  it('is never reached on workers.dev', () => {
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"invocation_logs": false');
  });
});
