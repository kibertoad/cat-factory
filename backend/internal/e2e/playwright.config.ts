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
  // A retry that passes after a first-attempt failure is a FLAKE, not a pass. Playwright's
  // default would still exit 0 (the test "eventually" passed), turning the shard job green
  // and hiding the failure. We want the opposite: a flaky shard must report RED so the
  // flake is visible. This does NOT block merging — `test-e2e` is deliberately kept out of
  // the aggregated `Test` gate's `needs` (see ci.yml), so a red shard is a signal to
  // investigate, not a merge stop. Retries stay on so the merged report still records what
  // eventually passed (the trace/video for diagnosis). Locally `retries: 0` means nothing
  // is ever flaky, so this has no effect there.
  failOnFlakyTests: true,
  // In CI the suite is sharded across jobs (playwright test --shard=i/N), so each shard
  // emits a `blob` report; a follow-on `test-e2e-report` job merges them into one HTML
  // report (`playwright merge-reports`). Locally we just want the live `list` output.
  reporter: process.env.CI ? [['blob'], ['list']] : 'list',
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
      // the backend above. We serve a PRODUCTION build (`nuxt build` → `nuxt preview`), not
      // `nuxt dev`: the dev server pre-bundles deps by crawling static imports only, so the
      // board page's `defineAsyncComponent(() => import(...))` panels hide their transitive
      // deps from the startup scan. Vite then discovers them at runtime and re-optimizes,
      // each re-optimization forcing a full page reload that aborts an in-flight `page.goto`
      // (`net::ERR_ABORTED`) and hangs a spec to its timeout — a flaky ~3min stall. A
      // production build has all chunks emitted ahead of time (no runtime re-optimization,
      // no reloads), which also makes this a more faithful test of the shipped artifact.
      // `--filter` makes the command cwd-independent; Nuxt's preview server binds `PORT`.
      command:
        'pnpm --filter @cat-factory/deploy-frontend run build && pnpm --filter @cat-factory/deploy-frontend run preview',
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      // Headroom for the one-off production build (libraries are already built by CI) plus
      // the preview server start.
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NUXT_PUBLIC_API_BASE: BACKEND_URL, PORT: String(FRONTEND_PORT) },
    },
  ],
})
