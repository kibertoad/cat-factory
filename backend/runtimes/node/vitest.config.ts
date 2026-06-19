import { defineConfig } from 'vitest/config'

// The Node facade's tests run in plain Node (NOT the Workers pool) against a real
// Postgres (`DATABASE_URL`) — the same persistence used in dev/prod, so the tests
// exercise the true schema + Drizzle repos. They include the shared cross-runtime
// conformance suite (`@cat-factory/conformance`), proving parity with the Worker.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Real Postgres is the single shared datastore; run serially so specs that
    // create workspaces don't contend, mirroring the Worker pool's singleWorker.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
