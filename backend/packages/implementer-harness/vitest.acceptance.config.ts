import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The acceptance suite builds and launches the Docker image and drives a full
// /run against a dummy streaming LLM proxy + a stub GitHub API. It is slow and
// needs a Docker daemon, so it is kept out of the default unit run and given
// generous timeouts. It self-skips when Docker is unavailable.
export default defineConfig({
  resolve: {
    alias: [
      // The real-proxy suite stands up the proxy from the worker's *internal*
      // source (LlmProxyController, ContainerSessionService) rather than its
      // published API. `@cat-factory/worker`'s exports map intentionally only
      // surfaces `.`/`./app`, so map the deep `/src/*` imports straight to the
      // sibling worker source for this test run.
      {
        find: /^@cat-factory\/worker\/src\/(.*)$/,
        replacement: `${fileURLToPath(new URL('../worker/src/', import.meta.url))}$1`,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One image/container at a time.
    fileParallelism: false,
  },
})
