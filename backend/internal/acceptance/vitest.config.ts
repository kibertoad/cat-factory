import { defineConfig } from 'vitest/config'

// The harness's OWN unit tests, and nothing else. This is the config `test:run` uses, so it is
// the one CI runs, and it must stay infra-free.
//
// **`src/` is deliberately outside the include**, which is what keeps this suite out of CI now that
// the acceptance scenarios live there rather than behind a second vitest config. They are plain
// modules a plain Node entry point walks (`src/runAcceptance.ts`), so nothing collects them by
// accident; what would put real model spend and a cluster requirement into a CI lane is widening
// this include to `**/*.test.ts` and adding a test file under `src/`. Tests go in `test/`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
