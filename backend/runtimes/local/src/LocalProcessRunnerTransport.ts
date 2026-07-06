import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type {
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { sanitizedChildEnv } from './childEnv.js'
import { requireHarnessSharedSecret } from './config.js'
import {
  EVICTION_ERROR,
  type HarnessEndpoint,
  pollHarnessJob,
  postHarnessJob,
  waitForHarnessHealth,
} from './harnessHttp.js'

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

/** The harness is always on loopback for the native host-process transport. */
const endpointFor = (port: number): HarnessEndpoint => ({ host: '127.0.0.1', port })

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
  /**
   * Shared secret injected as `HARNESS_SHARED_SECRET` + sent on every call. REQUIRED and must be
   * STABLE across restarts (the factory reads it via `requireHarnessSharedSecret`, which throws
   * loudly when unset); a per-process value would fail auth against a still-running harness after
   * a restart. The transport never invents one.
   */
  sharedSecret: string
  /** Extra env for the harness process (e.g. GITHUB_ALLOWED_HOSTS). */
  env?: Record<string, string>
  /**
   * What the harness child inherits from the parent's environment. `sanitized` (default)
   * projects it down to the {@link sanitizedChildEnv} allow-list so the orchestrator's
   * secrets (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, …) never reach the agent
   * subprocesses; `inherit` passes the full env through — the deploy harness needs it
   * (kubectl/helm run on ambient cloud/cluster env like KUBECONFIG and AWS_*).
   */
  envMode?: 'sanitized' | 'inherit'
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
  private readonly envMode: 'sanitized' | 'inherit'
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: typeof spawn
  private readonly pickPort: () => Promise<number>
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number

  /** The single long-lived harness process, started lazily and reused across all runs. */
  private proc: { child: ChildProcess; port: number; exited: boolean } | undefined
  private starting: Promise<{ child: ChildProcess; port: number; exited: boolean }> | undefined
  /** Set by {@link shutdown}; a shut-down transport never (re)spawns the harness. */
  private stopped = false
  /** The child of a start still in its health wait, so {@link shutdown} can kill it NOW
   * (flipping the health loop's `isDead`) instead of waiting out the ready timeout. */
  private startingChild: ChildProcess | undefined

  constructor(options: LocalProcessRunnerTransportOptions) {
    this.harnessEntry = options.harnessEntry
    this.nodePath = options.nodePath ?? process.execPath
    this.nodeArgs = options.nodeArgs ?? []
    this.sharedSecret = options.sharedSecret
    this.extraEnv = options.env ?? {}
    this.envMode = options.envMode ?? 'sanitized'
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
    await postHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(proc.port),
      secret: this.sharedSecret,
      body: { ...spec, kind },
      timeoutMs: this.requestTimeoutMs,
      label: 'Native harness',
    })
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    const proc = this.proc
    // The process died (or was never started) → report an eviction so the run can recover.
    if (!proc || proc.exited) return { state: 'failed', error: EVICTION_ERROR }
    return pollHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(proc.port),
      jobId: ref.jobId,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Native harness',
      isDead: () => proc.exited,
    })
  }

  /**
   * No per-run teardown: the harness host process is long-lived and reused across runs
   * (the harness already removes each job's ephemeral workspace itself). Provided so the
   * port contract is satisfied; kept idempotent.
   */
  async release(): Promise<void> {
    // intentionally a no-op
  }

  /**
   * Stop the harness process (for shutdown / tests). Idempotent and TERMINAL: a shut-down
   * transport refuses further dispatches. A start still in flight is awaited and its child
   * killed too, so a shutdown racing a lazy first dispatch can neither leak the harness
   * process nor let `ensureProcess` resurrect it afterwards.
   */
  async shutdown(): Promise<void> {
    this.stopped = true
    const starting = this.starting
    this.starting = undefined
    const proc = this.proc
    this.proc = undefined
    if (proc && !proc.exited) proc.child.kill()
    // Kill a mid-startup child directly — its exit flips the health loop's `isDead`, so the
    // in-flight start settles promptly instead of running out its ready timeout.
    this.startingChild?.kill()
    if (starting) {
      try {
        const handle = await starting
        if (!handle.exited) handle.child.kill()
      } catch {
        // The start failed on its own; startProcess already reaped its child.
      }
    }
  }

  // --- internals ----------------------------------------------------------

  private async ensureProcess(): Promise<{ child: ChildProcess; port: number; exited: boolean }> {
    if (this.stopped) throw new Error('the native harness transport is shut down')
    if (this.proc && !this.proc.exited) return this.proc
    this.starting ??= this.startProcess()
    try {
      const handle = await this.starting
      // shutdown() raced the start: it kills this child itself — don't resurrect it here.
      if (this.stopped) throw new Error('the native harness transport is shut down')
      this.proc = handle
      return handle
    } finally {
      this.starting = undefined
    }
  }

  private async startProcess(): Promise<{ child: ChildProcess; port: number; exited: boolean }> {
    const port = await this.pickPort()
    // `sanitized` (the default) confines the child to the allow-list env — the orchestrator's
    // secrets must not reach a host process whose whole job is spawning an agent with shell
    // access. The explicit vars below always win over the inherited base.
    const base = this.envMode === 'inherit' ? process.env : sanitizedChildEnv(process.env)
    const child = this.spawnImpl(this.nodePath, [...this.nodeArgs, this.harnessEntry], {
      env: {
        ...base,
        ...this.extraEnv,
        PORT: String(port),
        HARNESS_SHARED_SECRET: this.sharedSecret,
        // This transport only ever connects over loopback, and the harness runs UNSANDBOXED
        // on the developer's host — don't expose its agent-spawning API to the LAN.
        HARNESS_BIND_HOST: '127.0.0.1',
        // The harness only auto-listens when NODE_ENV !== 'test'.
        NODE_ENV: 'production',
      },
      stdio: 'ignore',
    })
    const handle = { child, port, exited: false }
    // The harness child is long-lived and not detached, but Node does NOT auto-kill a
    // child when the parent exits — without this, every dev restart orphans a `node
    // <harness>` process still bound to its port (and possibly mid-run on the developer's
    // live Claude/Codex login). `shutdown()` covers the graceful path; this `exit` hook is
    // the backstop for SIGTERM/SIGINT/uncaught exits that reach `process.exit` directly.
    const killOnParentExit = (): void => {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
    process.once('exit', killOnParentExit)
    child.on('exit', () => {
      handle.exited = true
      process.removeListener('exit', killOnParentExit)
      if (this.proc === handle) this.proc = undefined
    })
    this.startingChild = child
    try {
      // shutdown() may have flipped `stopped` while the port pick was pending (before the
      // spawn) — it had no child to kill then, so reap this one here instead of health-waiting.
      if (this.stopped) throw new Error('the native harness transport is shut down')
      await this.waitForHealth(port, handle)
    } catch (err) {
      // A harness that never became healthy must not linger holding its port (each retry
      // dispatch would leak another one). The 'exit' handler above removes the parent-exit
      // hook once the kill lands.
      if (!handle.exited) child.kill()
      throw err
    } finally {
      if (this.startingChild === child) this.startingChild = undefined
    }
    return handle
  }

  private waitForHealth(port: number, handle: { exited: boolean }): Promise<void> {
    return waitForHarnessHealth({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(port),
      readyTimeoutMs: this.readyTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      intervalMs: 200,
      isDead: () => handle.exited,
      deadError: 'the native harness process exited before becoming healthy',
      timeoutError: `Timed out waiting for the native harness on 127.0.0.1:${port} to become healthy`,
    })
  }
}

/**
 * The executor-harness server entry to spawn as a host process (`node <entry>`).
 *
 * Mirrors {@link resolveHarnessImage} for the container path: an explicit `LOCAL_HARNESS_ENTRY`
 * wins (a custom build or a source checkout), else we resolve the `@cat-factory/executor-harness`
 * package that ships with this backend — its `.` export is the zero-dependency `dist/server.js`.
 * So a fresh install runs native mode out of the box with no extra configuration, exactly like
 * an unset `LOCAL_HARNESS_IMAGE` falls back to the pinned recommended image.
 *
 * We only throw when native mode is on AND neither source is available — a case that should not
 * happen for a normal `pnpm add @cat-factory/local-server` install, but is worth a clear message
 * (e.g. a pruned/hoisting-broken `node_modules`).
 */
export function resolveHarnessEntry(env: NodeJS.ProcessEnv): string {
  const explicit = env.LOCAL_HARNESS_ENTRY?.trim()
  if (explicit) return explicit
  try {
    return createRequire(import.meta.url).resolve('@cat-factory/executor-harness')
  } catch (cause) {
    throw new Error(
      'Native local mode (LOCAL_NATIVE_AGENTS) needs the executor-harness server entry, but ' +
        "'@cat-factory/executor-harness' could not be resolved. It ships as a dependency of " +
        '@cat-factory/local-server — reinstall dependencies, or set LOCAL_HARNESS_ENTRY to the ' +
        'harness server entry path (its built dist/server.js) explicitly.',
      { cause },
    )
  }
}

/**
 * Build a {@link LocalProcessRunnerTransport} from the environment. The executor-harness server
 * entry is resolved via {@link resolveHarnessEntry} (`LOCAL_HARNESS_ENTRY` overrides, else the
 * bundled `@cat-factory/executor-harness`). The native CLIs (`claude` / `codex`) must already be
 * installed on the host.
 */
export function createLocalProcessTransportFromEnv(
  env: NodeJS.ProcessEnv,
): LocalProcessRunnerTransport {
  const harnessEntry = resolveHarnessEntry(env)
  const nodeArgs = env.LOCAL_HARNESS_NODE_ARGS?.trim()
    ? env.LOCAL_HARNESS_NODE_ARGS.trim().split(/\s+/)
    : undefined
  const allowedHosts = env.GITHUB_ALLOWED_HOSTS?.trim()
  return new LocalProcessRunnerTransport({
    harnessEntry,
    ...(nodeArgs ? { nodeArgs } : {}),
    sharedSecret: requireHarnessSharedSecret(env),
    ...(allowedHosts ? { env: { GITHUB_ALLOWED_HOSTS: allowedHosts } } : {}),
  })
}
