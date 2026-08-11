import { defineConfig } from 'vitest/config'
import { envFile } from './src/envFile.ts'

// The acceptance suite: real agents against a live deployment. NOT part of `test:run`, so no CI
// lane can reach it (see `vitest.config.ts` for the other half of that split).
//
// Five settings carry the whole shape of this suite:
//
//   - **`fileParallelism: false` and one worker.** The specs form ONE narrative (spec 02 ships
//     the feature spec 03 then files a bug against) and they share a repository, a workspace and
//     a cluster. Running two at once would have two runs racing on one repository's default
//     branch, which is the exact failure the platform's own task-dependency edges exist to
//     prevent. Note this does NOT make module state shared: vitest gives every test file its own
//     module graph regardless, which is why the facts specs pass to each other live in the
//     on-disk ledger (`src/world.ts`) rather than in a memoised object.
//   - **No timeout.** A real `pl_build` run dispatches container agents against a real model and
//     gates on real CI; there is no honest number to put here, and a vitest timeout firing
//     mid-run would abandon a provisioned k3s namespace and a half-open pull request rather than
//     report anything. Every wait in the suite carries its OWN deadline instead
//     (`src/deadline.ts`), so a stall is reported as "step `coder` was still `working` after
//     40m" rather than as an anonymous test timeout.
//   - **`bail: 1`.** The narrative is sequential, so the second failure is almost always the
//     first one's shadow. Stopping at the first keeps the ledger (`src/world.ts`) pointing at
//     the step that actually broke, which is what a re-run resumes from.
//   - **`env`, loaded from a `.env` beside this file.** Vitest does NOT read one on its own, so
//     the `.env` the README and `.gitignore` both describe was inert: the suite refused with
//     "CAT_FACTORY_BASE_URL is required" while the operator was looking at the line that sets it.
//     Eight variables, one of them an API key and one a ServiceAccount token, are more than
//     anyone wants to re-export per shell.
//   - **`globalSetup`, which asks for the personal password.** It runs in the MAIN process, before
//     any worker exists and before the reporter draws a line, which is the only place in this suite
//     a prompt can be both asked once and read. See `acceptance/globalSetup.ts`.
export default defineConfig({
  test: {
    env: envFile(import.meta.dirname),
    globalSetup: ['acceptance/globalSetup.ts'],
    include: ['acceptance/**/*.acceptance.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    // 0 DISABLES these two (verified: a deliberately slow test passes under them). Note that
    // `teardownTimeout` does NOT share that meaning: 0 there is a literal zero milliseconds, and
    // setting it makes every run end with "Timeout terminating forks worker". It is left at its
    // default: tearing a worker down is not the thing that takes an hour.
    testTimeout: 0,
    hookTimeout: 0,
    bail: 1,
    reporters: ['verbose'],
  },
})
