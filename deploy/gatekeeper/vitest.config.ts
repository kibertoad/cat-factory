import { defineConfig } from 'vitest/config'

// A plain Node run, no workerd. What this package still tests is its POLICY, which is pure data
// compiled against the generated operation table, and the `/policy` entry point it reads that
// compiler from carries no Worker runtime for exactly this reason. The machinery's own suite (real
// Durable Object, real Cap'n Web, real WebCrypto) lives with the machinery, in
// `@cat-factory/gatekeeper-worker`, so a copy of this template does not inherit a test harness for
// code it did not write.

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
