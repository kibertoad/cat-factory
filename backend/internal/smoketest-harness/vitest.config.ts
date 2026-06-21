import { defineConfig } from 'vitest/config'

// Plain node-environment unit tests. The analysers are pure functions over a
// captured Pi event stream, so the suite is fast and fully offline — it never
// spawns Pi or touches the network. The real smoketests run via `cat-smoke run`,
// deliberately NOT in CI (they need a configured Cloudflare account + the `pi` CLI).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
