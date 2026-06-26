import { defineConfig, devices } from '@playwright/test'

// e2e against the assembled product: Playwright drives a real Chromium against the real
// SPA (Nuxt dev server), which talks to the real Node backend (real Postgres + real
// WebSocket) booted by `src/testServer.ts` with the external deps faked. Both servers are
// started by Playwright's `webServer` below; nothing else is needed beyond a reachable
// `DATABASE_URL` (Postgres) — CI provides one, mirroring the existing `test-rest` job.
const BACKEND_PORT = Number(process.env.PORT ?? 8787)
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3000)
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

export default defineConfig({
  testDir: './tests',
  // Postgres is a single shared datastore and each spec seeds its own workspace(s); run
  // files serially so a run-to-completion in one file can't race another's polling.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  // A live run advances through several durable pg-boss steps; give web-first assertions
  // headroom over the default 5s without resorting to fixed sleeps.
  expect: { timeout: 15_000 },
  timeout: 60_000,
  use: {
    baseURL: FRONTEND_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // A dropped WebSocket event or a card that never flips is far easier to diagnose from
    // a recording than a single end-state screenshot; kept to failures so green runs are cheap.
    video: 'retain-on-failure',
    // Opt-in for environments that ship a preinstalled Chromium and block `playwright
    // install` downloads (e.g. sandboxes): point at the binary instead of fetching one.
    // Unset in CI, which installs the matching browser the normal way.
    ...(process.env.E2E_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } }
      : {}),
  },
  metadata: { backendUrl: BACKEND_URL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The real backend with the deterministic fakes.
      command: 'node --env-file-if-exists=.env src/testServer.ts',
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // Allow-list the SPA's actual origin for CORS — derived from the SAME port var the
      // frontend server binds, so overriding E2E_FRONTEND_PORT can't desync them and
      // silently break every in-browser REST call.
      env: { PORT: String(BACKEND_PORT), CORS_ALLOWED_ORIGINS: FRONTEND_URL },
    },
    {
      // The SPA (the @cat-factory/app layer via the deploy/frontend consumer), pointed at
      // the backend above. `--filter` makes the command cwd-independent; Nuxt binds the
      // port from `PORT`.
      command: 'pnpm --filter @cat-factory/deploy-frontend run dev',
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NUXT_PUBLIC_API_BASE: BACKEND_URL, PORT: String(FRONTEND_PORT) },
    },
  ],
})
