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

// DEBUG ONLY (branch debug/story-lane-fix-check): record what navigates the orchestrator page.
const navlog = process.env.NAVLOG
const NAV_SCRIPT = `
(() => {
  const send = (kind, data) => navigator.sendBeacon('/__navlog', JSON.stringify({ t: Date.now(), kind, url: location.href, ...data }))
  send('orchestrator-load', {})
  if (window.navigation) {
    navigation.addEventListener('navigate', (e) => send('navigate', {
      type: e.navigationType, dest: e.destination.url, sameDoc: e.destination.sameDocument,
      userInitiated: e.userInitiated, canIntercept: e.canIntercept, stack: new Error().stack,
    }))
  }
  addEventListener('beforeunload', () => send('beforeunload', { stack: new Error().stack }))
  addEventListener('pagehide', (e) => send('pagehide', { persisted: e.persisted }))
  addEventListener('popstate', (e) => send('popstate', { state: String(e.state) }))
})()
`

export default defineConfig({
  plugins: navlog
    ? [
        {
          name: 'debug:navlog',
          configureServer(server) {
            server.middlewares.use('/__navlog', (req, res) => {
              let body = ''
              req.on('data', (c) => (body += c))
              req.on('end', () => {
                appendFileSync(navlog, body + '\n')
                res.statusCode = 204
                res.end()
              })
            })
          },
        },
      ]
    : [],
  test: {
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
            orchestratorScripts: navlog ? [{ content: NAV_SCRIPT }] : [],
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
