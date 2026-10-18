import { appendFileSync } from 'node:fs'
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

const mswlog = process.env.MSWLOG
export default defineConfig({
  plugins: mswlog ? [{ name: 'debug:mswlog', configureServer(server) { server.middlewares.use('/__mswlog', (req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { appendFileSync(mswlog, b + '\n'); res.statusCode = 204; res.end() }) }) } }] : [],
  test: {
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
        test: {
          name: 'stories',
          setupFiles: ['./debug-beacons.ts'],
          // Read by `.storybook/preview.ts`, which runs an empty story first only in this lane.
          env: { STORY_TEST_LANE: 'true' },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { args: [...(process.env.EXPOSE_GC ? ['--js-flags=--expose-gc'] : []), ...(process.env.CDP ? ['--remote-debugging-port=9333'] : [])] } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
