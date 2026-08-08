import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  composePostMortem,
  describeProcessExit,
  redactSecrets,
  type RunnerDispatchAck,
  type RunnerJobStopOutcome,
  type RunnerDispatchKind,
  type RunnerJobRef,
  type RunnerJobView,
  type RunnerTransport,
} from '@cat-factory/kernel'
import { logger } from '@cat-factory/server'
import { sanitizedChildEnv } from './childEnv.js'
import { requireHarnessSharedSecret } from './config.js'
import { recommendedHarnessVersion, verifyHarnessVersion } from './harnessVersion.js'
import {
  EVICTION_ERROR,
  type EvictionCause,
  type HarnessEndpoint,
  pollHarnessJob,
  postHarnessJob,
  stopHarnessJob,
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

/**
 * How much of the harness process's stderr to keep for a post-mortem.
 *
 * A ring rather than a whole capture: this is a diagnostic for the moment the process dies, not
 * a log sink, and it is held for the LIFETIME of a long-lived process. Sized well under
 * `composePostMortem`'s own cap so the one-line verdict in front of it always survives.
 */
const STDERR_TAIL_CHARS = 2_000

/** The single long-lived harness process, and what it printed on its way out. */
interface HarnessProcess {
  child: ChildProcess
  port: number
  exited: boolean
  /**
   * Which harness process this is, counting from 1. The transport respawns after a death, so
   * "the harness process" is not one thing over a session's life, and every question a
   * post-mortem asks ("is the process answering now the one this job was dispatched to?") is a
   * question about WHICH one. See {@link LocalProcessRunnerTransport.jobGenerations}.
   */
  generation: number
  /** The rolling tail of the child's stderr, read live because the stream is not replayable. */
  stderrTail: () => string
}

/**
 * How a harness process ended: the only account anyone gets of a native-mode job whose host
 * process died under it. Kept on the transport rather than the handle, because the handle is
 * dropped the moment the child exits and the poll that needs this runs afterwards.
 */
interface HarnessProcessExit {
  /** The {@link HarnessProcess.generation} this is the death of. */
  generation: number
  code: number | null
  signal: string | null
  /** Mutable so `close` (which fires after the stream drains) can complete what `exit` saw. */
  stderr: string
}

/**
 * How many jobs' process generations to remember.
 *
 * The map is pruned as jobs settle, so it only ever holds the in-flight ones plus whatever was
 * abandoned mid-poll; the cap is the backstop for a session that accumulates the latter forever.
 * Evicting the oldest costs that job the named account of its process's death and drops it to
 * the "no record survives" branch, which is a statement, not a silence.
 */
const MAX_TRACKED_JOB_GENERATIONS = 1_000

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
  /**
   * The harness version this backend is matched to (the tag of `RECOMMENDED_HARNESS_IMAGE`).
   * When set, a freshly-healthy harness is version-checked against it; a mismatch fails the
   * dispatch loudly. Undefined ⇒ no check.
   */
  expectedVersion?: string
  /**
   * The operator pointed `LOCAL_HARNESS_ENTRY` at a custom build, so a version mismatch is a
   * WARNING rather than a hard stop.
   */
  allowVersionMismatch?: boolean
  /** Where a soft (custom-override) version warning is surfaced. Default: no-op. */
  onVersionWarning?: (message: string) => void
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
  /** Backend id recorded in run diagnostics (native host process, ambient CLI login). */
  readonly backend = 'local-native'
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
  private readonly expectedVersion?: string
  private readonly allowVersionMismatch: boolean
  private readonly onVersionWarning?: (message: string) => void

  /** The single long-lived harness process, started lazily and reused across all runs. */
  private proc: HarnessProcess | undefined
  private starting: Promise<HarnessProcess> | undefined
  /** How many harness processes this transport has spawned; the newest one's generation. */
  private generations = 0
  /**
   * How the most recent harness process ended, retained ACROSS the next spawn. This is what turns
   * "container evicted or crashed" into an exit code and the stderr that preceded it: the harness
   * writes its warn/error lines there, so a crash's last words are the whole diagnosis.
   *
   * Retained across the respawn because that is precisely when it is read. One process serves
   * every concurrent job, so its death evicts all of them at once, and answering the first
   * eviction re-dispatches, which spawns the replacement, while the siblings are still to poll.
   * Clearing on spawn threw the record away between the first job's post-mortem and the rest of
   * them, so the jobs that died in exactly the same crash got nothing.
   *
   * It carries its {@link HarnessProcessExit.generation}, so it is only ever spent on jobs that
   * were actually running under it: retaining a record and misattributing it are one edit apart.
   */
  private lastExit: HarnessProcessExit | undefined
  /**
   * Which harness process each dispatched job was handed to, so a poll can tell "the process
   * serving this job is gone" from "the process serving this job is alive and has forgotten it".
   *
   * Both answer a 404, and they are opposite facts. Without the dispatch generation the poll can
   * only see the process answering NOW, so a job that died with the previous one is told its
   * harness "is still serving other local runs", a sentence about somebody else's process,
   * offered in place of the crash that actually killed it.
   */
  private readonly jobGenerations = new Map<string, number>()
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
    this.expectedVersion = options.expectedVersion
    this.allowVersionMismatch = options.allowVersionMismatch ?? false
    this.onVersionWarning = options.onVersionWarning
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
  ): Promise<RunnerDispatchAck | undefined> {
    const proc = await this.ensureProcess()
    // Remember WHICH harness process is taking this job, before the POST rather than after: a
    // dispatch that throws mid-flight may still have registered the job, and a job the harness
    // knows about with no generation recorded is the one case the post-mortem cannot reason
    // about at all.
    this.rememberJobGeneration(ref.jobId, proc.generation)
    // The harness keys jobs by the per-step `ref.jobId` in the body; a re-dispatch
    // (durable-driver replay) re-POSTs, which the JobRegistry treats as a re-attach.
    return postHarnessJob({
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
    // The process died (or was never started) → report an eviction so the run can recover,
    // carrying whatever the process THIS job was dispatched to left behind.
    if (!proc || proc.exited) {
      const detail = this.describeJobsProcessExit(ref.jobId)
      return this.settled(ref.jobId, {
        state: 'failed',
        error: EVICTION_ERROR,
        evicted: 'crash',
        ...(detail ? { detail } : {}),
      })
    }
    const view = await pollHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(proc.port),
      jobId: ref.jobId,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Native harness',
      isDead: () => proc.exited,
      postMortem: (cause) => Promise.resolve(this.processPostMortem(cause, ref.jobId, proc)),
    })
    return this.settled(ref.jobId, view)
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
   * Stop ONE job at the harness. This is where the split from {@link release} pays: release is a
   * no-op here (the host process outlives every job and serves every concurrent one), so a caller
   * that had only release had no way at all to stop a job on the native leg, and this leg runs
   * the agent UNSANDBOXED on the developer's own machine, where a run nobody wanted keeps editing
   * a real checkout.
   *
   * A dead process is a stopped job; anything else is the harness's own answer, which throws when
   * it could not confirm the abort.
   */
  async stopJob(ref: RunnerJobRef): Promise<RunnerJobStopOutcome> {
    const proc = this.proc
    this.jobGenerations.delete(ref.jobId)
    if (!proc || proc.exited) return 'stopped'
    await stopHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(proc.port),
      jobId: ref.jobId,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Native harness',
    })
    return 'stopped'
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

  /**
   * The post-mortem for a job whose poll fell to an eviction, given which branch it took.
   *
   * This backend OUTLIVES a single run: one host process serves every concurrent local job. So
   * the two branches are not the same question, exactly as they are not for the local warm pool.
   * On `unreachable` the process is confirmed gone while this job was running, so its exit and
   * final stderr are this job's last words (and every other in-flight job's too, which is worth
   * saying).
   *
   * `job_unknown` is the branch that needs the dispatch generation, because it covers two
   * opposite situations that a 404 alone cannot tell apart. The process answering may be the one
   * this job was handed to, in which case it is alive and has simply forgotten the job, and a
   * stderr tail lifted off it now would attach somebody else's work to this failure. Or it may
   * be its REPLACEMENT: the process serving this job died, another in-flight job's eviction was
   * answered by a re-dispatch, and that spawned the fresh process now returning the 404. There
   * the job died in a crash we hold the record of, and the live process's innocence is not the
   * answer to anything.
   */
  private processPostMortem(
    cause: EvictionCause,
    jobId: string,
    answering: HarnessProcess,
  ): string | undefined {
    if (cause === 'unreachable') return this.describeJobsProcessExit(jobId)
    const dispatchedTo = this.jobGenerations.get(jobId)
    if (dispatchedTo !== undefined && dispatchedTo !== answering.generation) {
      return this.describeJobsProcessExit(jobId, {
        preface:
          'A DIFFERENT native harness process is serving local runs now: the one this job was ' +
          'dispatched to is gone, and the 404 is the replacement never having heard of the job.',
      })
    }
    return composePostMortem([
      'The native harness process this job was dispatched to answered the poll and no longer ' +
        'knows this job: it reaped it, or the job never registered. It is that same process, ' +
        "still serving other local runs, so its output is not this run's and no stderr tail is " +
        'attached.',
    ])
  }

  /**
   * How the harness process that was serving `jobId` ended, or a statement that nothing is known.
   *
   * Never silently empty, and never somebody else's death. Three answers, because they need three
   * different next steps: here is the exit and the stderr that preceded it; the process is gone
   * but no record of THIS job's process survives (a later one has since died and taken the slot);
   * and this backend never dispatched the job at all, so it cannot say which process had it.
   *
   * The generation check is what separates the second from the first. A single retained record
   * plus a respawning process is exactly the setup where "the last exit" and "this job's exit"
   * quietly stop being the same thing, and reporting one as the other puts a wrong cause of death
   * on the run with no sign that it is wrong.
   */
  private describeJobsProcessExit(jobId: string, opts?: { preface?: string }): string | undefined {
    const dispatchedTo = this.jobGenerations.get(jobId)
    const exit = this.lastExit
    if (dispatchedTo === undefined) {
      return composePostMortem([
        opts?.preface,
        'The native harness host process is not serving this job, and this backend never ' +
          'dispatched it (the orchestrator restarted since), so it cannot say which process was ' +
          'running it or how that process ended.',
      ])
    }
    if (!exit || exit.generation !== dispatchedTo) {
      return composePostMortem([
        opts?.preface,
        'The native harness host process that was running this job is gone, and no record of ' +
          'how it ended survives: this backend keeps only the most recent process death, and a ' +
          'later one has replaced it.',
      ])
    }
    const stderr = exit.stderr.trim()
    return composePostMortem([
      opts?.preface,
      `The native harness host process ${describeProcessExit(exit.code, exit.signal)} while the ` +
        `job was running. It serves every concurrent local job, so anything else in flight died ` +
        `with it.`,
      stderr
        ? `Harness stderr (last ${STDERR_TAIL_CHARS} characters):\n${stderr}`
        : 'It printed nothing to stderr before exiting.',
    ])
  }

  /**
   * Record which harness process took a job, bounded by {@link MAX_TRACKED_JOB_GENERATIONS}.
   *
   * A `Map` iterates in insertion order, so the oldest entry is the first key; re-setting an
   * existing job (a replayed dispatch) is deliberately left in place rather than re-inserted, so
   * a long-running job cannot be evicted by its own re-dispatches.
   */
  private rememberJobGeneration(jobId: string, generation: number): void {
    this.jobGenerations.set(jobId, generation)
    while (this.jobGenerations.size > MAX_TRACKED_JOB_GENERATIONS) {
      const oldest = this.jobGenerations.keys().next()
      if (oldest.done) break
      this.jobGenerations.delete(oldest.value)
    }
  }

  /**
   * Forget a job that has reached a terminal state, and hand the view back untouched.
   *
   * The generation map exists to answer an eviction, and a settled job will never ask again. Left
   * to grow it would be a leak in a process that outlives every run on the machine.
   */
  private settled(jobId: string, view: RunnerJobView): RunnerJobView {
    if (view.state !== 'running') this.jobGenerations.delete(jobId)
    return view
  }

  private async ensureProcess(): Promise<HarnessProcess> {
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

  private async startProcess(): Promise<HarnessProcess> {
    const port = await this.pickPort()
    // The PREVIOUS process's exit record is deliberately kept. One process serves every
    // concurrent job, so its death evicts all of them and the first eviction answered is what
    // spawns this replacement, while the siblings that died in the same crash have yet to poll.
    // The record is keyed by generation, so keeping it cannot misattribute it: a job dispatched
    // to THIS process reads its own generation and finds no match.
    const generation = ++this.generations
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
      // stderr is PIPED (stdout stays ignored): the harness routes its warn/error lines and any
      // uncaught crash there, and it is the only account of a host process that dies mid-job.
      // Nothing is forwarded to this process's own stderr, so the developer's console is exactly
      // as quiet as it was; the tail is buffered and read only on a post-mortem. It must be
      // consumed either way, because an unread pipe fills and blocks the child.
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderrTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)
    })
    const handle: HarnessProcess = {
      child,
      port,
      generation,
      exited: false,
      stderrTail: () => stderrTail,
    }
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
    // This child's own exit record, so `close` can only ever complete ITS entry: identity, not a
    // "is anything newer here" heuristic, because a second process may have started and died in
    // between and overwriting its tail with this child's is the same misattribution the
    // generation stamp exists to prevent one level up.
    let record: HarnessProcessExit | undefined
    child.on('exit', (code, signal) => {
      handle.exited = true
      // Recorded on `exit` rather than `close` so a poll landing in the gap between the two still
      // gets an answer; `close` then completes the tail, since stderr may still be draining.
      record = { generation, code, signal, stderr: stderrTail }
      this.lastExit = record
      process.removeListener('exit', killOnParentExit)
      if (this.proc === handle) this.proc = undefined
    })
    child.on('close', () => {
      if (record && this.lastExit === record) this.lastExit = { ...record, stderr: stderrTail }
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

  private async waitForHealth(port: number, handle: HarnessProcess): Promise<void> {
    // Both messages are composed LAZILY (the loop's `LazyError` thunks), so the stderr tail is
    // read only on the failure branch. A harness that will not boot at all (a bad
    // LOCAL_HARNESS_ENTRY, a port clash, a Node version it refuses) says so on stderr and said it
    // to nobody before this: the dispatch failed with a sentence that named only the symptom.
    const withStderr = (reason: string) => (): string => {
      const stderr = handle.stderrTail().trim()
      return stderr ? `${reason}. Harness stderr:\n${redactSecrets(stderr)}` : reason
    }
    await waitForHarnessHealth({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(port),
      readyTimeoutMs: this.readyTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      intervalMs: 200,
      isDead: () => handle.exited,
      deadError: withStderr('the native harness process exited before becoming healthy'),
      timeoutError: withStderr(
        `Timed out waiting for the native harness on 127.0.0.1:${port} to become healthy`,
      ),
    })
    // Safety net: verify the spawned harness matches the version this backend expects, failing
    // the dispatch loudly on a skew (e.g. an outdated installed @cat-factory/executor-harness)
    // instead of surfacing it later as a cryptic git/agent error.
    await verifyHarnessVersion({
      fetchImpl: this.fetchImpl,
      endpoint: endpointFor(port),
      secret: this.sharedSecret,
      requestTimeoutMs: this.requestTimeoutMs,
      expected: this.expectedVersion,
      custom: this.allowVersionMismatch,
      source: { ref: this.harnessEntry, kind: 'native' },
      onWarn: this.onVersionWarning,
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
    // Version handshake: check the spawned harness against the matched version. An explicit
    // LOCAL_HARNESS_ENTRY is a deliberate custom build, so a mismatch there is a warning.
    expectedVersion: recommendedHarnessVersion(),
    allowVersionMismatch: !!env.LOCAL_HARNESS_ENTRY?.trim(),
    onVersionWarning: (message) => logger.warn(message),
  })
}
