// Serve a SECOND instance of the already-built SPA, pointed at the auth-enabled backend.
//
// The SPA is `ssr: false`, so its API base is baked in at BUILD time, except that the Nitro server
// serving the shell re-reads `NUXT_PUBLIC_API_BASE` at STARTUP and injects it into the page. That is
// what makes a second origin free: no second build, just a second process over the same `.output`
// with a different API base. (A second build would double the slowest step in the e2e job.)
//
// Playwright starts its `webServer` entries in parallel, and this one's artifact is produced by the
// primary frontend's `build` step, so it waits for that build to land the server bundle instead of
// exiting on a missing file and taking the whole run's setup down with it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '../../../../deploy/frontend')
const entry = join(frontendDir, '.output/server/index.mjs')

const port = process.env.E2E_AUTH_FRONTEND_PORT ?? '3001'
const apiBase =
  process.env.E2E_AUTH_BACKEND_URL ?? `http://localhost:${Number(process.env.PORT ?? 8787) + 2}`
/** How long to wait for the primary frontend's build to emit the server bundle. */
const BUILD_WAIT_MS = 240_000
const POLL_MS = 1_000

const deadline = Date.now() + BUILD_WAIT_MS
while (!existsSync(entry)) {
  if (Date.now() > deadline) {
    console.error(
      `[e2e] auth frontend: ${entry} never appeared. It is built by the primary frontend webServer ` +
        `entry (pnpm --filter @cat-factory/deploy-frontend run build); run that first.`,
    )
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}

// The bundle exists, but the build writes it progressively, so give the writer a beat rather than
// importing a half-flushed chunk graph. Nitro loads its chunks lazily on the first request, so a
// premature start fails as a runtime error inside a request, which reads like a product bug.
await new Promise((r) => setTimeout(r, POLL_MS))

console.log(`[e2e] auth frontend on :${port} → ${apiBase}`)
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), NUXT_PUBLIC_API_BASE: apiBase },
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
