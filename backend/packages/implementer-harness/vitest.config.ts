import { defineConfig } from 'vitest/config'

// Local config so vitest doesn't walk up to the repo-root (Nuxt) config. The
// harness is plain Node code, so it runs in the node environment.
export default defineConfig({
  test: {
    environment: 'node',
    // Fast unit tests only. The Docker-based acceptance suite has its own config
    // (vitest.acceptance.config.ts) so `pnpm test` never needs a Docker daemon.
    include: ['test/*.test.ts'],
  },
})
