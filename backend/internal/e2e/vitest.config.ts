import { defineConfig } from 'vitest/config'

// Unit coverage for the test-only backend SEAMS under `src/` (the per-workspace fake wiring),
// deliberately scoped away from `tests/`, which holds the Playwright specs — vitest's default
// `include` would otherwise collect `tests/*.spec.ts` and try to run the browser suite here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
