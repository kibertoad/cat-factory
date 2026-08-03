import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the comparator's own unit tests. The smoketest itself is not a vitest suite — it needs
    // a real backend and four toolchains, and is driven by `pnpm run smoketest`.
    include: ['test/**/*.test.ts'],
  },
})
