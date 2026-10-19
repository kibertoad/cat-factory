import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Runs every story as a test in a real Chromium, with the a11y check turned on, so the axe sweep
// is a command rather than something someone remembers to do.
//
// ON REQUEST, and nightly once #2442 restores the schedule. The file is named `vitest.stories.config.ts` and the script
// `test:stories`, so neither Turbo's `test:run` lane nor `test:quick` nor `ci.yml` picks it up;
// `.github/workflows/stories.yml` runs it. It boots a browser and the whole Nuxt Vite graph, about
// 10 minutes for the tree, so it does not belong in a lane a PR waits on.
//
//   pnpm --filter @cat-factory/storybook run test:stories
const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    // Each worker is a Chromium page, and past a few they add contention, not speed. 3 is what
    // Vitest gives CI's 4-vCPU runner. Why, and how to re-check it: docs/internal/storybook.md.
    maxWorkers: 3,
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
        test: {
          name: 'stories',
          // Read by `.storybook/preview.ts`, which runs an empty story first only in this lane.
          env: { STORY_TEST_LANE: 'true' },
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
