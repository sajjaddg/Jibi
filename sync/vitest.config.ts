import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/** The test key's public half, so entitlements signed in a test verify. */
const testKey = (JSON.parse(readFileSync('../billing/test/vectors/valid.json', 'utf8')) as { keys: string[] }).keys[0];

/**
 * Runs the real Worker and real Durable Objects under workerd, so the tests exercise the same
 * SQLite and the same one-request-at-a-time execution that production does. `worker/` has no
 * tests at all; this one holds people's ledgers, so it does.
 *
 * `cloudflareTest` is a Vite plugin as of vitest-pool-workers 0.20 — the older
 * `defineWorkersConfig` helper it replaced no longer exists.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      // Compaction ships switched off (wrangler.jsonc); the tests run it, and
      // test/compaction.test.ts switches it back off to check what «off» does.
      // CHURN=full runs test/churn.test.ts at the volume docs/backend-plan.md reports.
      miniflare: { bindings: { COMPACTION: 'on', CHURN: process.env.CHURN ?? '', ENTITLEMENT_PUBLIC_KEYS: testKey } },
    }),
  ],
});
