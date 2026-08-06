// Serve a SECOND instance of the already-built SPA, pointed at the auth-enabled backend.
//
// The SPA is `ssr: false`, so its API base is baked in at BUILD time, except that the Nitro server
// serving the shell re-reads `NUXT_PUBLIC_API_BASE` at STARTUP and injects it into the page. That is
// what makes a second origin free: no second build, just a second process over the same `.output`
// with a different API base. (A second build would double the slowest step in the e2e job.)
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTH_BACKEND_URL, AUTH_FRONTEND_PORT, FRONTEND_URL } from './ports.ts'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '../../../../deploy/frontend')
const entry = join(frontendDir, '.output/server/index.mjs')

/** How long to wait for the primary frontend's build to land. */
const BUILD_WAIT_MS = 240_000
const POLL_MS = 1_000

/** Whether something is answering at `url` (any response: the server is up). */
const isServing = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(POLL_MS) })
    return true
  } catch {
    return false
  }
}

// Playwright starts its `webServer` entries in parallel, and this one RUNS the bundle the primary
// frontend entry builds, so it must not start until that build has landed. The signal is the primary
// SPA answering: its command is `nuxt build && nuxt preview`, so a response means the build finished
// and `.output` is complete and stable.
//
// Waiting on the FILE instead would start on whatever an earlier run left there, and both outcomes
// are silent: `nuxt build` cleans `.output` under this process, so a lazily-loaded chunk fails inside
// a request (which reads like a product bug); or it survives and serves the PREVIOUS build, missing
// whatever the specs now select. When Playwright REUSES an already-running primary server (locally,
// via `reuseExistingServer`), no build runs and that server's `.output` is the artifact under test,
// which this same condition admits immediately.
const deadline = Date.now() + BUILD_WAIT_MS
while (!(await isServing(FRONTEND_URL))) {
  if (Date.now() > deadline) {
    console.error(
      `[e2e] auth frontend: the primary SPA never came up at ${FRONTEND_URL}. It is built and served ` +
        `by the primary frontend webServer entry (pnpm --filter @cat-factory/deploy-frontend run ` +
        `build && … run preview); this process serves that build's output, so it waits for it.`,
    )
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}

if (!existsSync(entry)) {
  console.error(
    `[e2e] auth frontend: ${FRONTEND_URL} is serving but ${entry} is missing. The primary entry is ` +
      `expected to be that build's own preview server; something else is answering on that port.`,
  )
  process.exit(1)
}

console.log(`[e2e] auth frontend on :${AUTH_FRONTEND_PORT} → ${AUTH_BACKEND_URL}`)
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(AUTH_FRONTEND_PORT),
    NUXT_PUBLIC_API_BASE: AUTH_BACKEND_URL,
  },
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true
    child.kill(signal)
  })
}

// A signal death leaves `code === null`, and reporting that as 0 would make the auth SPA's
// disappearance (an OOM kill, a segfault) look like a clean shutdown: Playwright's teardown accepts
// it and the auth specs then fail on connection-refused timeouts naming nothing. Our OWN teardown
// kill is the one signal that IS a clean exit.
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code)
  if (!shuttingDown) {
    console.error(`[e2e] auth frontend: the SPA server was killed by ${signal}`)
    process.exit(1)
  }
  process.exit(0)
})
