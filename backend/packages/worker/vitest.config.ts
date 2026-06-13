import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

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
          // Workflows are declared in wrangler.toml; the pool requires shared
          // (non-isolated) storage to run them. Tests stay independent by
          // scoping every aggregate under a freshly-created workspace id.
          isolatedStorage: false,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            // Surface the parsed migrations to the setup file, and force a
            // deterministic seed so the simulator path is reproducible if used.
            // EXECUTION_MODE stays 'tick' so the engine behaves deterministically
            // and the durable Workflows path isn't exercised in-pool.
            bindings: {
              TEST_MIGRATIONS: migrations,
              RNG_SEED: '42',
              AGENTS_ENABLED: 'false',
              EXECUTION_MODE: 'tick',
            },
          },
        },
      },
    },
  }
})
