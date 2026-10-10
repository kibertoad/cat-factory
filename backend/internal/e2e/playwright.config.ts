import { defineConfig, devices } from '@playwright/test'
// Every port and origin comes from the ONE derivation the backend, the launcher and the specs' own
// helpers read (`src/ports.ts`), so what Playwright starts is what the specs open under any override.
import {
  AUTH_BACKEND_PORT,
  AUTH_BACKEND_URL,
  AUTH_FRONTEND_PORT,
  AUTH_FRONTEND_URL,
  BACKEND_PORT,
  BACKEND_URL,
  FRONTEND_PORT,
  FRONTEND_URL,
} from './src/ports.ts'

// e2e against the assembled product: Playwright drives a real Chromium against the real
// SPA (Nuxt dev server), which talks to the real Node backend (real Postgres + real
// WebSocket) booted by `src/testServer.ts` with the external deps faked. Both servers are
// started by Playwright's `webServer` below; nothing else is needed beyond a reachable
// `DATABASE_URL` (Postgres) — CI provides one, mirroring the existing `test-rest` job.
//
// The AUTH-ENABLED stack (`AUTH_BACKEND_URL` / `AUTH_FRONTEND_URL`) is a second HTTP surface over the
// SAME backend process (`src/authBackend.ts`) and a second instance of the SAME SPA build pointed at
// it (`src/authFrontend.mjs`). It exists for the specs whose subject is identity (the login screen,
// and any policy that names PEOPLE), which the primary `TESTING_NO_AUTH` stack structurally cannot
// show.

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
  // investigate, not a merge stop. Retries stay on so the trace/video for diagnosis is still
  // captured. Locally `retries: 0` means nothing is ever flaky, so this has no effect there.
  failOnFlakyTests: true,
  // `list` gives live console output in every environment. In CI the suite is sharded across
  // jobs (playwright test --shard=i/N) and each shard fails loudly on its own via the step's
  // exit code; there is no combined-report merge job, so the diagnosis material is the shard
  // console output plus the per-shard `test-results/` trace + video uploaded as an artifact.
  reporter: 'list',
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
      // Allow-list the SPA's actual origin for CORS, and hand this process the RESOLVED ends of the
      // auth stack it also serves: the port its second listener binds, and the SPA origin allowed to
      // call it. Passing the resolved values (rather than letting each side re-derive) is what stops
      // an override moving one end and silently breaking every in-browser REST call.
      env: {
        PORT: String(BACKEND_PORT),
        CORS_ALLOWED_ORIGINS: FRONTEND_URL,
        E2E_AUTH_PORT: String(AUTH_BACKEND_PORT),
        E2E_AUTH_FRONTEND_URL: AUTH_FRONTEND_URL,
      },
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
      // Emit client sourcemaps for this e2e build (Nuxt maps `NUXT_SOURCEMAP_CLIENT`
      // onto `sourcemap.client`). This is diagnosis material, exactly like the retained
      // trace/video above: when a spec fails on an in-browser exception, the stack maps
      // back to source instead of a minified `Nn(...)` frame. Scoped to the e2e build
      // only — the real `deploy/frontend` production build is unaffected.
      env: {
        NUXT_PUBLIC_API_BASE: BACKEND_URL,
        PORT: String(FRONTEND_PORT),
        NUXT_SOURCEMAP_CLIENT: 'true',
      },
    },
    {
      // The same SPA build served a second time against the auth-enabled backend surface. Runs the
      // emitted server bundle directly (no second `nuxt build`): the shell re-reads
      // NUXT_PUBLIC_API_BASE at startup, so the API base is a runtime choice here. The launcher waits
      // for the entry ABOVE to be serving before it starts, since webServer entries start in parallel
      // and that entry's `nuxt build` rewrites the very `.output` this one runs.
      command: 'node src/authFrontend.mjs',
      url: AUTH_FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      // The primary build plus this process's own start: the same budget as the build it waits for.
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // The three resolved ends the launcher needs: the port it binds (the one this entry's `url`
      // waits on, whichever knob moved it), the auth backend the SPA is pointed at, and the primary
      // SPA whose build it is waiting for.
      env: {
        E2E_AUTH_FRONTEND_PORT: String(AUTH_FRONTEND_PORT),
        E2E_AUTH_BACKEND_URL: AUTH_BACKEND_URL,
        E2E_FRONTEND_URL: FRONTEND_URL,
      },
    },
  ],
})
