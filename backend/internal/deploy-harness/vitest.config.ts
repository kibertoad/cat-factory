import { defineConfig } from 'vitest/config'

// Local config so vitest doesn't walk up to the repo-root (Nuxt) config. The
// harness is plain Node code, so it runs in the node environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
  },
})
