import { configDefaults, defineConfig } from 'vitest/config'

// @cat-factory/server hosts the runtime-neutral HTTP layer. Its tests are PURE unit
// tests of the shared logic — mappers, crypto/signing, CORS, the redirect guard, the
// auth gate (with a faked container) — so they run in plain Node with no DB and no
// workerd, on any platform. Cross-runtime *integration* behaviour stays in the
// conformance suite (run by each facade against its real datastore).
export default defineConfig({
  test: {
    // Both layouts: the `test/*.spec.ts` suites and the co-located `src/**/*.test.ts`
    // unit tests (e.g. the crypto ciphers, provider capabilities) — the latter must be
    // included explicitly or they silently never run.
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    // The gateway integration lane drives a real third-party container and matches the pattern
    // above, so it has to be excluded by name; it runs only via `vitest.integration.config.ts`
    // (the `test:integration` script). Left in, every contributor without a Docker daemon would
    // get a silent skip here and read it as coverage.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    // Silences the process-wide logger so a green run's output is its assertions, not the
    // application's own lines. See the file for why the gate (rather than per-site
    // `noopLogger` injection) is the seam.
    setupFiles: ['test/setup/silenceLogs.ts'],
  },
})
