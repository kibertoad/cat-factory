import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config'

// Integration tests run inside the real Workers runtime (workerd, the same
// engine Wrangler uses) against a real local D1 database — not mocks. The D1
// migrations are read here and applied per test file in test/apply-migrations.ts.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations')

  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            // Surface the parsed migrations to the setup file, and force a
            // deterministic seed so the simulator path is reproducible if used.
            bindings: {
              TEST_MIGRATIONS: migrations,
              RNG_SEED: '42',
              AGENTS_ENABLED: 'false',
            },
          },
        },
      },
    },
  }
})
