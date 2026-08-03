// Booting the deployment the SDKs are smoketested against, and seeding it.
//
// The backend is the REAL Node facade — the same shared Hono app, real Postgres, real pg-boss
// durable execution — with only the external dependencies faked, exactly as the Playwright e2e
// suite runs it. Reusing `@cat-factory/e2e`'s `testServer.ts` rather than composing a second one
// is deliberate: a smoketest that ran against a bespoke wiring would prove the SDKs work against
// THAT, and the wiring is precisely the thing most likely to drift.

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require_ = createRequire(import.meta.url)

/** The e2e package's `testServer.ts`, resolved through the workspace dependency. */
function testServerEntry(): string {
  const manifest = require_.resolve('@cat-factory/e2e/package.json')
  return resolve(dirname(manifest), 'src/testServer.ts')
}

export interface RunningBackend {
  baseUrl: string
  /** The test-only control channel's port (see `seedWorkspace`). */
  controlPort: number
  stop(): Promise<void>
}

/**
 * Boot the backend and wait for it to answer.
 *
 * The child inherits this process's env plus the knobs below. `E2E_DECISION_ON_STEPS` is cleared
 * on purpose: the e2e suite defaults it to `0` so every run parks once on a human decision, which
 * is what those specs are testing — here it would park the smoketest's run before it produced any
 * progress, and the SSE step would observe a decision frame instead of the run advancing.
 */
export async function startBackend(port: number): Promise<RunningBackend> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'sdk-smoketest: DATABASE_URL is required (e.g. postgres://postgres:postgres@127.0.0.1:5432/cat_factory_sdk_smoketest)',
    )
  }

  const child = spawn(process.execPath, ['--experimental-strip-types', testServerEntry()], {
    env: {
      ...process.env,
      PORT: String(port),
      E2E_CONTROL_PORT: String(port + 1),
      E2E_DECISION_ON_STEPS: '',
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Keep the child's output, but only PRINT it when the boot fails. A healthy boot logs a page of
  // migration and pg-boss noise that would bury the harness's own report; a failed one is the
  // only thing that explains why.
  const log: string[] = []
  child.stdout?.on('data', (chunk) => log.push(String(chunk)))
  child.stderr?.on('data', (chunk) => log.push(String(chunk)))

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(baseUrl, child)
  } catch (error) {
    console.error(log.join(''))
    await stopChild(child)
    throw error
  }

  return {
    baseUrl,
    controlPort: port + 1,
    stop: () => stopChild(child),
  }
}

/** Poll the deployment until it answers, or the child dies, or we give up. */
async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sdk-smoketest: the backend exited during boot (code ${child.exitCode})`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`sdk-smoketest: the backend did not become healthy in time (${lastError})`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

export interface SeededWorkspace {
  workspaceId: string
  /** An `admin`-scoped key: the scenario deletes a task, which sits at the top of the ladder. */
  adminKey: string
  /** A `read`-scoped key, so the scenario can observe a typed `insufficient_scope` refusal. */
  readKey: string
}

/** Create a seeded, account-backed workspace and mint the two keys the scenario needs. */
export async function seedWorkspace(
  baseUrl: string,
  controlPort: number,
): Promise<SeededWorkspace> {
  // An ACCOUNT-BACKED board, over the test control channel. Public-API keys are an account-scoped
  // feature and minting one for an account-less board is refused (`404 Workspace not found`)
  // rather than persisting an orphan key — while `POST /accounts` needs a signed-in user, so
  // there is no anonymous REST path to one. The control channel is the seam that exists for
  // exactly this (it already seeds GitHub and the RBAC scenario the same way).
  const { workspaceId } = await postJson<{ workspaceId: string }>(
    `http://127.0.0.1:${controlPort}/account-workspace-seed`,
    // The sample architecture, so there is a service frame to create tasks under and a built-in
    // pipeline catalog to start them with.
    { seed: true },
  )

  // The KEYS themselves go through the ordinary session-authed management route, which is
  // dev-open on this backend — the same route an operator uses. Minting through a back door
  // would leave the key-issuing path itself untested, and it is the first thing every
  // integration touches.
  const admin = await postJson<{ secret: string }>(
    `${baseUrl}/workspaces/${workspaceId}/public-api-keys`,
    { label: 'sdk smoketest (admin)', scope: 'admin' },
  )
  const read = await postJson<{ secret: string }>(
    `${baseUrl}/workspaces/${workspaceId}/public-api-keys`,
    { label: 'sdk smoketest (read)', scope: 'read' },
  )

  return { workspaceId, adminKey: admin.secret, readKey: read.secret }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`sdk-smoketest: POST ${url} → ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}
