import { defineConfig } from 'vitest/config'

// The Node facade's tests run in plain Node (NOT the Workers pool) against a real
// Postgres (`DATABASE_URL`) — the same persistence used in dev/prod, so the tests
// exercise the true schema + Drizzle repos. They include the shared cross-runtime
// conformance suite (`@cat-factory/conformance`), proving parity with the Worker.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // File parallelism is safe: each vitest worker gets its OWN Postgres database
    // (`setupTestDb` → `deriveWorkerDatabase`), so concurrent spec files on different
    // workers never contend on shared tables. Files sharing a worker still run
    // sequentially against that worker's database, isolated by per-test workspace ids.
    testTimeout: 30_000,
  },
})
