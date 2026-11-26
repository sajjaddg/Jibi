import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** The real Worker under workerd with a local D1, migrated from the same files production takes. */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { setupFiles: ['./test/migrate.ts'] },
  };
});
