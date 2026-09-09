import { defineConfig } from 'vitest/config'

// The gateway INTEGRATION lane (`test/integration/*.it.spec.ts`): our provider resolvers over real
// HTTP against a real third-party gateway in Docker, with only the model upstream stubbed. It
// needs a Docker daemon, so it is kept out of the default unit run (see `vitest.config.ts`) and
// self-skips when there is none, mirroring the executor-harness acceptance suite.
//
// `hookTimeout` is the wide one because a COLD run pulls the gateway image inside `beforeAll`:
// the harness owns the pinned tag so that it is written once, which means the pull lands here
// rather than in a CI step. The per-test timeout can stay tight, since by then everything the
// tests touch is local.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.it.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // One container at a time, and the suites share the host's Docker daemon.
    fileParallelism: false,
    setupFiles: ['test/setup/silenceLogs.ts'],
  },
})
