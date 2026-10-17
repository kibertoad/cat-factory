import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Runs every story as a test in a real Chromium, with the a11y check turned on, so the axe sweep
// is a command rather than something someone remembers to do.
//
// NIGHTLY AND ON REQUEST. The file is named `vitest.stories.config.ts` and the script
// `test:stories`, so neither Turbo's `test:run` lane nor `test:quick` nor `ci.yml` picks it up;
// `.github/workflows/stories.yml` runs it. It boots a browser and the whole Nuxt Vite graph, about
// 10 minutes for the tree, so it does not belong in a lane a PR waits on.
//
//   pnpm --filter @cat-factory/storybook run test:stories
const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    // Vitest's default is every core, capped at 12 in browser mode, and each worker is a Chromium
    // page. On a large machine the lane took the whole CPU, and under load the first story of each
    // file passed its 15s timeout. On a 40-file batch, 4 workers ran as fast as 7 or 12 with less
    // load; CI's 4-vCPU runner already gets about 4. Pass `--maxWorkers` to override it for a run.
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
        test: {
          name: 'stories',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
