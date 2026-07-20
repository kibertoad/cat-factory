import { defineConfig } from 'vitest/config'

// The local facade's tests run in plain Node. The transport + runtime-adapter unit
// tests (`LocalContainerRunnerTransport`, `runtimes/*`) are pure (injected CLI exec +
// fetch) and need no daemon or Postgres. The cross-runtime conformance spec drives the
// real composition
// root against a real Postgres (`DATABASE_URL`) with a fake agent executor — exactly
// like the Node/Worker suites — so the local facade can't drift from the others.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    // File parallelism is safe: each vitest worker gets its OWN Postgres database
    // (`setupTestDb` → `deriveWorkerDatabase`, labelled `local` so it never collides with
    // the Node suite's), so concurrent spec files on different workers don't contend. The
    // pure transport/runtime-adapter unit tests touch no database at all.
    testTimeout: 30_000,
    // Match the hook budget to the test budget: real-Postgres specs do heavyweight DDL
    // (`CREATE DATABASE` / `DROP DATABASE ... WITH (FORCE)`) in beforeAll/afterAll, which can
    // exceed vitest's default 10s hook timeout under parallel CI load.
    hookTimeout: 30_000,
  },
})
