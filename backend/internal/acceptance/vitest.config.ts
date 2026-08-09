import { defineConfig } from 'vitest/config'

// The harness's OWN unit tests, and nothing else. This is the config `test:run` uses, so it is
// the one CI runs: it must stay infra-free, which is why `acceptance/` is deliberately outside
// the include. Vitest's default include would collect `acceptance/*.acceptance.ts` and start
// spending real money against a deployment CI does not have.
//
// The acceptance suite is `vitest.acceptance.config.ts`, reachable only through
// `pnpm --filter @cat-factory/acceptance run acceptance`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
