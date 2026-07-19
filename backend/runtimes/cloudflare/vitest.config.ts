import { createRequire } from 'node:module'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Integration tests run inside the real Workers runtime (workerd, the same
// engine Wrangler uses) against a real local D1 database — not mocks. The D1
// migrations are read here and applied per test file in test/apply-migrations.ts.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  // The dedicated telemetry database has its own migration lineage.
  const telemetryMigrations = await readD1Migrations('./telemetry-migrations')
  const sandboxMigrations = await readD1Migrations('./sandbox-migrations')
  const provisioningMigrations = await readD1Migrations('./migrations-provisioning')

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
        // NOTE: the v3 `isolatedStorage`/`singleWorker` pool options no longer
        // exist on the v4 `cloudflareTest` plugin schema (it strips unknown
        // keys), so they are omitted here. v4 already runs the suite against
        // shared, non-isolated storage in a single worker; tests stay
        // independent by scoping every aggregate under a freshly-created
        // workspace id, and migrations are applied once per file in
        // test/apply-migrations.ts.
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Surface the parsed migrations to the setup file. Tests drive the
          // engine directly via advanceInstance (no durable Workflows in-pool)
          // and inject a FakeAgentExecutor, so no agent/provider env is needed.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_TELEMETRY_MIGRATIONS: telemetryMigrations,
            // Sandbox D1 migrations, applied to the SANDBOX_DB binding per test file so
            // the Sandbox feature is exercised against its true schema.
            TEST_SANDBOX_MIGRATIONS: sandboxMigrations,
            TEST_MIGRATIONS_PROVISIONING: provisioningMigrations,
            // The auth gate fails closed when unconfigured; tests send no
            // credentials, so opt into the local/dev-open path (mirrors
            // `.dev.vars` for `wrangler dev`). Production never sets this.
            AUTH_DEV_OPEN: 'true',
            // A session secret so the workspace-RBAC conformance suite can drive requests as real
            // signed sessions (a dev-open harness resolves no access and passes RBAC assertions
            // vacuously). With no OAuth/password provider set, `enabled` stays false and dev-open
            // still passes token-less requests through unchanged for every other suite.
            AUTH_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
            // A non-empty secret so the GitHub connect-state HMAC signer works
            // in tests. GITHUB_APP_ID stays unset, so the integration is still
            // "disabled" by config and tests wire the module via overrides.
            GITHUB_WEBHOOK_SECRET: 'test-state-secret',
            // One shared 32-byte master key backs every integration's credential
            // cipher (documents/tasks/environments/runners) — the cipher
            // domain-separates per integration via its HKDF `info`. REQUIRED: the
            // always-on document/task integrations throw at config load without it,
            // and `documentsDeps()`/`tasksDeps()` build their ciphers from it.
            // Production sets this as a secret.
            ENCRYPTION_KEY: 'c2hhcmVkLW1hc3Rlci1rZXktMDEyMzQ1Njc4OWFiY2RlZg==',
            // Enable the opt-in runner-pool integration so its real service wires up; its
            // specs stub global `fetch` to act as the scheduler. (The environment
            // integration assembles from ENCRYPTION_KEY above — no flag.)
            RUNNERS_ENABLED: 'true',
            // Enable the Slack notification transport so its module + channel wire up;
            // the conformance Slack CRUD asserts persistence parity with Node, and the
            // channel bails (best-effort) when a workspace has no Slack connection.
            SLACK_ENABLED: 'true',
            // Enable the observability integration (release-health module + connection API) so
            // the post-release-health gate conformance can connect a provider and create a
            // pipeline carrying the observability-gated `post-release-health` step. Parity with
            // the Node test env; the gate's runtime verdict comes from a faked
            // ReleaseHealthProvider, not a real Datadog call.
            OBSERVABILITY_ENABLED: 'true',
            // Force the deterministic heading planner for the env-wired documents
            // module (now always on): spawn specs assert exact board structure and
            // must not reach an LLM. Specs that exercise the LLM planner inject a
            // model provider + planner ref via overrides instead.
            DOCUMENT_PLANNER: 'headings',
            // Enable every document source explicitly so the conformance suite can
            // exercise each provider's connect/list/disconnect on this facade.
            DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // These run inside real workerd against a real local D1, and the heaviest
      // engine specs drive a run to a standstill TWICE (park on a decision / the
      // spend gate, resolve it, then drive again) — each round is real store I/O.
      // Vitest's 5s unit-test default leaves no headroom under parallel CI shard
      // load, so a legitimately-passing double-drive test (~5–6s) occasionally
      // tips over into a spurious timeout. The driver is budget-bounded
      // (`maxRounds`/`jobMaxPolls`), so a genuinely stuck run fails fast via a
      // wrong-status assertion, never a hang — meaning a timeout here only ever
      // means "slow", not "broken". 10s roughly doubles the observed worst case:
      // enough to absorb CI variance without letting a real stall sit for long.
      testTimeout: 10_000,
      hookTimeout: 10_000,
    },
    resolve: {
      // Pin `toad-cache` to its CommonJS build inside the Workers test pool.
      //
      // `toad-cache` is dual-published (`"type": "module"` with `require` →
      // `.cjs`, `import` → `.mjs`), and `layered-loader` (our AppCaches backend)
      // consumes it from compiled CJS via `require("toad-cache")`. The
      // `@cloudflare/vitest-pool-workers` module-fallback resolves a `require()`
      // by asking Vite for the `require` export condition (it threads
      // `custom["node-resolve"].isRequire` into `resolveId`), then shims the CJS
      // module's named exports via `cjs-module-lexer`. Under Vite 8 that
      // `isRequire` hint is no longer honoured for a dual package, so the pool
      // resolves `toad-cache` to its ESM `.mjs`; `cjs-module-lexer` can't parse
      // ESM, the shim produces no exports, and `require("toad-cache")` comes back
      // `undefined` — so every `new InMemoryGroupCache()` throws
      // `Cannot read properties of undefined (reading 'LruObject')` and the whole
      // request path 500s (this is what reddened the worker suite on the Nuxt 4.5
      // / Vite 7→8 bump). Aliasing straight to the resolved `.cjs` file bypasses
      // the exports-condition ambiguity and restores the Vite-7 behaviour. This
      // is test-pool-only (the production Worker bundle is built by wrangler/
      // esbuild, unaffected); drop it once the pool honours `isRequire` on Vite 8.
      alias: {
        'toad-cache': createRequire(import.meta.url).resolve('toad-cache'),
      },
    },
  }
})
