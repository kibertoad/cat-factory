import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Integration tests run inside the real Workers runtime (workerd, the same
// engine Wrangler uses) against a real local D1 database — not mocks. The D1
// migrations are read here and applied per test file in test/apply-migrations.ts.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')

  return {
    // vitest-pool-workers v4 wires the Workers pool through a Vite plugin
    // (`cloudflareTest`) instead of the old `test.poolOptions.workers` block.
    plugins: [
      cloudflareTest({
        // The `[ai]` binding in wrangler.toml has no local simulator, so
        // wrangler v4 would try to open an authenticated remote proxy session
        // for it on startup. Tests inject a FakeAgentExecutor and never touch
        // env.AI, so opt out of remote bindings to keep the suite fully local.
        remoteBindings: false,
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
            // Enable the self-hosted runner-pool integration with a fixed 32-byte
            // master key so the real RunnerPoolConnectionService + cipher wire up;
            // runner specs stub global `fetch` to act as the pool scheduler.
            RUNNERS_ENABLED: 'true',
            RUNNERS_ENCRYPTION_KEY: 'cnVubmVycy10ZXN0LWtleS0wMTIzNDU2Nzg5YWJjZGU=',
            // Master key so the document-source integration's credential
            // encryption-at-rest wires up; `documentsDeps()` builds the cipher
            // from it. Production sets this as a secret.
            DOCUMENTS_ENCRYPTION_KEY: 'ZG9jdW1lbnRzLXRlc3Qta2V5LTAxMjM0NTY3ODlhYmM=',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
