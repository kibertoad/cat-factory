import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type {
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'

// The NATIVE local runner backend (opt-in via `LOCAL_NATIVE_AGENTS`): instead of a Docker
// container per run, it runs the SAME executor-harness as a long-lived HOST PROCESS on
// 127.0.0.1 and drives it through the harness's existing HTTP API. So all the harness
// machinery — git clone/push/PR, structured-output, watchdogs, the JobRegistry, progress —
// is reused unchanged; the only difference from the container transport is WHERE the harness
// runs (a host `node` process vs a container) and that the agent uses the developer's OWN
// installed `claude` / `codex` CLI with its ambient login (the executor sets `ambientAuth`
// on the job, so no credential is leased). This bypasses Docker entirely.
//
// SECURITY: the agent runs as a plain host subprocess with the developer's full shell/file
// access and their personal subscription — no container sandbox, no spend metering, no
// model-locking. Acceptable ONLY because local mode is the developer's own machine; it is
// therefore opt-in (default off) and reachable only from `buildLocalContainer`.

const EVICTION_ERROR = 'Job not found (container evicted or crashed)'
const SECRET_HEADER = 'x-harness-secret'

export interface LocalProcessRunnerTransportOptions {
  /**
   * Path to the executor-harness HTTP server entry (its `server.js`/`server.ts`). Spawned
   * as `node <entry>`; with a `.ts` entry, Node's type-stripping (Node 24+) runs it.
   */
  harnessEntry: string
  /** Node executable to spawn the harness with. Default `process.execPath`. */
  nodePath?: string
  /** Extra args to pass to node before the entry (e.g. `--experimental-strip-types`). */
  nodeArgs?: string[]
  /** Shared secret injected as `HARNESS_SHARED_SECRET` + sent on every call. Default random. */
  sharedSecret?: string
  /** Extra env for the harness process (e.g. GITHUB_ALLOWED_HOSTS). */
  env?: Record<string, string>
  /** Injectable fetch — defaults to the global. */
  fetchImpl?: typeof fetch
  /** Injectable spawn — defaults to node:child_process.spawn (overridable in tests). */
  spawnImpl?: typeof spawn
  /** Injectable free-port picker — defaults to an ephemeral OS port (overridable in tests). */
  pickPort?: () => Promise<number>
  /** How long to wait for the harness `/health` after spawn. Default 30s. */
  readyTimeoutMs?: number
  /** Per-HTTP-call timeout. Default 30s. */
  requestTimeoutMs?: number
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** An ephemeral free localhost port (best-effort; a tiny TOCTOU window is fine for dev). */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('could not pick a free port'))))
    })
  })
}

export class LocalProcessRunnerTransport implements RunnerTransport {
  private readonly harnessEntry: string
  private readonly nodePath: string
  private readonly nodeArgs: string[]
  private readonly sharedSecret: string
  private readonly extraEnv: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: typeof spawn
  private readonly pickPort: () => Promise<number>
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number

  /** The single long-lived harness process, started lazily and reused across all runs. */
  private proc: { child: ChildProcess; port: number; exited: boolean } | undefined
  private starting: Promise<{ child: ChildProcess; port: number; exited: boolean }> | undefined

  constructor(options: LocalProcessRunnerTransportOptions) {
    this.harnessEntry = options.harnessEntry
    this.nodePath = options.nodePath ?? process.execPath
    this.nodeArgs = options.nodeArgs ?? []
    this.sharedSecret = options.sharedSecret ?? randomBytes(24).toString('hex')
    this.extraEnv = options.env ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
    this.spawnImpl = options.spawnImpl ?? spawn
    this.pickPort = options.pickPort ?? ephemeralPort
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
  ): Promise<void> {
    const proc = await this.ensureProcess()
    // The harness keys jobs by the per-step `ref.jobId` in the body; a re-dispatch
    // (durable-driver replay) re-POSTs, which the JobRegistry treats as a re-attach.
    const res = await this.fetchImpl(this.url(proc.port, '/jobs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: this.sharedSecret },
      body: JSON.stringify({ ...spec, kind }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!res.ok) {
      throw new Error(`Native harness dispatch failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    const proc = this.proc
    // The process died (or was never started) → report an eviction so the run can recover.
    if (!proc || proc.exited) return { state: 'failed', error: EVICTION_ERROR }
    let res: Response
    try {
      res = await this.fetchImpl(this.url(proc.port, `/jobs/${encodeURIComponent(ref.jobId)}`), {
        method: 'GET',
        headers: { [SECRET_HEADER]: this.sharedSecret },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (err) {
      if (proc.exited) return { state: 'failed', error: EVICTION_ERROR }
      throw err
    }
    if (res.status === 404) return { state: 'failed', error: EVICTION_ERROR }
    if (!res.ok) {
      throw new Error(`Native harness job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    return (await res.json()) as RunnerJobView
  }

  /**
   * No per-run teardown: the harness host process is long-lived and reused across runs
   * (the harness already removes each job's ephemeral workspace itself). Provided so the
   * port contract is satisfied; kept idempotent.
   */
  async release(): Promise<void> {
    // intentionally a no-op
  }

  /** Stop the harness process (for shutdown / tests). Idempotent. */
  async shutdown(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.starting = undefined
    if (proc && !proc.exited) proc.child.kill()
  }

  // --- internals ----------------------------------------------------------

  private async ensureProcess(): Promise<{ child: ChildProcess; port: number; exited: boolean }> {
    if (this.proc && !this.proc.exited) return this.proc
    this.starting ??= this.startProcess()
    try {
      this.proc = await this.starting
      return this.proc
    } finally {
      this.starting = undefined
    }
  }

  private async startProcess(): Promise<{ child: ChildProcess; port: number; exited: boolean }> {
    const port = await this.pickPort()
    const child = this.spawnImpl(this.nodePath, [...this.nodeArgs, this.harnessEntry], {
      env: {
        ...process.env,
        ...this.extraEnv,
        PORT: String(port),
        HARNESS_SHARED_SECRET: this.sharedSecret,
        // The harness only auto-listens when NODE_ENV !== 'test'.
        NODE_ENV: 'production',
      },
      stdio: 'ignore',
    })
    const handle = { child, port, exited: false }
    child.on('exit', () => {
      handle.exited = true
      if (this.proc === handle) this.proc = undefined
    })
    await this.waitForHealth(port, handle)
    return handle
  }

  private async waitForHealth(port: number, handle: { exited: boolean }): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      if (handle.exited)
        throw new Error('the native harness process exited before becoming healthy')
      try {
        const res = await this.fetchImpl(this.url(port, '/health'), {
          method: 'GET',
          signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 5_000)),
        })
        if (res.ok) return
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the native harness on 127.0.0.1:${port} to become healthy`,
        )
      }
      await delay(200)
    }
  }

  private url(port: number, path: string): string {
    return `http://127.0.0.1:${port}${path}`
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}

/**
 * Build a {@link LocalProcessRunnerTransport} from the environment. Requires
 * `LOCAL_HARNESS_ENTRY` (the path to the executor-harness server entry to run as a host
 * process). The native CLIs (`claude` / `codex`) must already be installed on the host.
 */
export function createLocalProcessTransportFromEnv(
  env: NodeJS.ProcessEnv,
): LocalProcessRunnerTransport {
  const harnessEntry = env.LOCAL_HARNESS_ENTRY?.trim()
  if (!harnessEntry) {
    throw new Error(
      'LOCAL_HARNESS_ENTRY is required for native local mode (LOCAL_NATIVE_AGENTS): set it to ' +
        'the executor-harness server entry path (its built server.js, or src/server.ts run via ' +
        'Node type-stripping).',
    )
  }
  const nodeArgs = env.LOCAL_HARNESS_NODE_ARGS?.trim()
    ? env.LOCAL_HARNESS_NODE_ARGS.trim().split(/\s+/)
    : undefined
  const allowedHosts = env.GITHUB_ALLOWED_HOSTS?.trim()
  return new LocalProcessRunnerTransport({
    harnessEntry,
    ...(nodeArgs ? { nodeArgs } : {}),
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    ...(allowedHosts ? { env: { GITHUB_ALLOWED_HOSTS: allowedHosts } } : {}),
  })
}
