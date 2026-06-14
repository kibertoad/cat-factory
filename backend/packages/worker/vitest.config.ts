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
          // Run all test files in one worker, sequentially. With shared storage
          // they target the same D1, so applying migrations per file in parallel
          // races on CREATE TABLE; serialising removes that race.
          singleWorker: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            // Surface the parsed migrations to the setup file. Tests drive the
            // engine directly via advanceInstance (no durable Workflows in-pool)
            // and inject a FakeAgentExecutor, so no agent/provider env is needed.
            bindings: {
              TEST_MIGRATIONS: migrations,
              // The auth gate fails closed when unconfigured; tests send no
              // credentials, so opt into the local/dev-open path (mirrors
              // `.dev.vars` for `wrangler dev`). Production never sets this.
              AUTH_DEV_OPEN: 'true',
              // A non-empty secret so the GitHub connect-state HMAC signer works
              // in tests. GITHUB_APP_ID stays unset, so the integration is still
              // "disabled" by config and tests wire the module via overrides.
              GITHUB_WEBHOOK_SECRET: 'test-state-secret',
              // Enable the environment integration with a fixed 32-byte master
              // key so the real HttpEnvironmentProvider + WebCryptoSecretCipher
              // wire up; env specs stub global `fetch` to act as the provider.
              ENVIRONMENTS_ENABLED: 'true',
              ENVIRONMENTS_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            },
          },
        },
      },
    },
  }
})
