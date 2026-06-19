import { defineConfig } from 'vitest/config'

// The acceptance suite builds and launches the Docker image and drives a full
// /run against a dummy streaming LLM proxy + a stub GitHub API. It is slow and
// needs a Docker daemon, so it is kept out of the default unit run and given
// generous timeouts. It self-skips when Docker is unavailable.
//
// The real-proxy suite stands up the shared proxy from its published API
// (`@cat-factory/server`: `llmProxyController` + `ContainerSessionService`), so no
// deep-source alias is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One image/container at a time.
    fileParallelism: false,
  },
})
