import { defineConfig } from 'vitest/config'

// Kernel is the shared pure-logic + ports package, so its unit tests run with coverage
// enforced. The thresholds are a RATCHET pinned to the coverage present when kernel got its
// own test runner — they lock in the currently-tested logic (gate-logic, gate-registry,
// doc-quality-logic) so a later change can't quietly drop it, without forcing back-tests of
// the historically-untested modules. Raise them as more kernel logic gains tests; never lower.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      enabled: true,
      // `all` counts every source file (not just those a test imported), so an untested new
      // module drags coverage down and trips the ratchet — the point of the floor.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary'],
      // Pinned to the current measured coverage (floored to whole percents so a deterministic
      // recount can't trip it): statements 16.68% / branches 15.98% / functions 11.68% /
      // lines 17.26%. These are a floor — raise them as coverage grows, never lower.
      thresholds: {
        statements: 16,
        branches: 15,
        functions: 11,
        lines: 17,
      },
    },
  },
})
