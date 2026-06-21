import { defineConfig } from 'vitest/config'

// The local facade's tests run in plain Node. The transport unit test
// (`LocalDockerRunnerTransport`) is pure (injected docker exec + fetch) and needs no
// Docker or Postgres. The cross-runtime conformance spec drives the real composition
// root against a real Postgres (`DATABASE_URL`) with a fake agent executor — exactly
// like the Node/Worker suites — so the local facade can't drift from the others.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    // The conformance spec shares one Postgres; run serially so workspace-creating
    // specs don't contend, mirroring the Node pool.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
