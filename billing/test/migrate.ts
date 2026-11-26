import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
