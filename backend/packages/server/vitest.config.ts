import { defineConfig } from 'vitest/config'

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
  },
})
