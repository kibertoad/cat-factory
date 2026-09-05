/**
 * Effects half of `cat-factory supervise`: the health probe, the optional container dependency,
 * the port reaper, the supervised child, and the loop that drives them from the pure decisions in
 * `supervise.ts`.
 *
 * Everything the loop touches is behind a seam so `runSupervisor` can be driven by fakes — the
 * same discipline `host-shell.ts` sets out for the k3s flow. Shell-outs go through {@link HostShell}
 * rather than `node:child_process` directly; the one exception is the supervised child itself,
 * which needs inherited stdio and a live handle, so it gets its own {@link ChildLauncher} seam.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { COMMAND_NOT_FOUND, type HostShell } from './host-shell.js'
import {
  initialState,
  type RecoveryCause,
  type SuperviseConfig,
  stateAfterStart,
  step,
} from './supervise.js'

/** Probes whether the supervised service is actually SERVING (not merely booted). */
export interface HealthProbe {
  serving(): Promise<boolean>
}

/** A prerequisite the supervised service needs — a database container, a local cluster, … */
export interface ServiceDependency {
  /** Human-readable name for logs. */
  readonly label: string
  /**
   * Bring it up if needed; resolve `true` once it is ready, `false` to retry on the next cycle.
   * Throw {@link OperatorActionRequiredError} for a state no retry can clear.
   */
  ensure(): Promise<boolean>
}

/**
 * Thrown by a dependency that cannot be repaired without a human. The loop prints the message ONCE
 * and stops treating the step as retryable noise — the alternative is a watchdog that repeats a
 * hopeless action forever, which is the exact pathology (a restart loop that reads as progress)
 * this supervisor exists to end.
 */
export class OperatorActionRequiredError extends Error {}

/** A running supervised child process. */
export interface SupervisedChild {
  readonly pid: number | undefined
  /** Kill the child AND its descendants. Never throws. */
  kill(): Promise<void>
  /** Resolves when the process exits, with its code/signal. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>
}

/** Starts the supervised command. */
export interface ChildLauncher {
  start(): SupervisedChild
}

/** Frees a port held by an orphaned listener, so a restart can bind it again. */
export interface PortReaper {
  /** Resolves with the PIDs actually killed (empty when the port was already free). */
  reap(): Promise<string[]>
}

/** Injectable clock, so tests never wait in real time. */
export interface SuperviseClock {
  now(): number
  /** Resolves after `ms`, or EARLY if `signal` aborts — so Ctrl-C isn't stuck behind a poll interval. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/**
 * NOTE the deliberately un-`unref`'d timers throughout this module. An `unref`'d timer does not keep
 * the event loop alive, and while a spawned child DOES hold it open, that reference vanishes the
 * moment the child dies — which is precisely when the supervisor must keep running. With `unref` the
 * poll timer was then the only thing left, so Node exited 0 the instant its child was killed: a
 * watchdog that died with its patient, silently and with a success code.
 */
const systemClock: SuperviseClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      // Without this a Ctrl-C would sit out the remainder of the poll interval before the loop
      // noticed, so the shutdown that is supposed to reap the child takes up to `--poll` seconds.
      function onAbort(): void {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

const PROBE_CONNECT_TIMEOUT_MS = 2_000
const PROBE_HTTP_TIMEOUT_MS = 3_000

/**
 * The real probe. "Serving" requires BOTH signals, because the two failure modes differ: a parked
 * `node --watch` leaves nothing bound to the port, while a server that booted but wedged (or lost
 * its DB pool) still holds the socket and only fails the HTTP check.
 *
 * Both address families are tried — a Node server on `0.0.0.0` answers on 127.0.0.1, but some dev
 * servers bind IPv6 `::1` only, and probing one family would report a false outage.
 */
export function createHealthProbe(opts: { port: number; healthPath: string }): HealthProbe {
  const hosts = ['127.0.0.1', '::1']

  const connect = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port: opts.port, timeout: PROBE_CONNECT_TIMEOUT_MS })
      const done = (result: boolean): void => {
        socket.destroy()
        resolve(result)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.once('timeout', () => done(false))
    })

  const healthy = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const req = http.get(
        { host, port: opts.port, path: opts.healthPath, timeout: PROBE_HTTP_TIMEOUT_MS },
        (res) => {
          res.resume() // drain, so the socket can close
          resolve(res.statusCode === 200)
        },
      )
      req.once('error', () => resolve(false))
      req.once('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })

  return {
    async serving() {
      const listening = await Promise.all(hosts.map(connect))
      if (!listening.some(Boolean)) return false
      const answers = await Promise.all(hosts.map(healthy))
      return answers.some(Boolean)
    },
  }
}

const COMPOSE_READY_TIMEOUT_MS = 90_000
const COMPOSE_POLL_MS = 2_000

/**
 * A `docker compose` service the supervised process needs. This is the piece that makes recovery
 * work after the container engine itself restarted: the example compose files set no restart
 * policy on Postgres, so anything that stops the engine leaves the DB down, and relaunching the
 * server against a missing (or still-initialising) database just crashes it again in `migrate`.
 */
export function createComposeDependency(
  shell: HostShell,
  opts: {
    /**
     * Directory holding the `docker-compose.yml`. Passed as the shell-out's `cwd` on EVERY compose
     * call, never merely stored: compose resolves its project file relative to the working
     * directory, so a supervisor started from anywhere else would address no project at all and
     * report a permanently un-ready database instead of restoring it.
     */
    dir: string
    service: string
    /** Overridable so tests don't wait out the real readiness budget. */
    readyTimeoutMs?: number
    readyPollMs?: number
  },
): ServiceDependency {
  const readyTimeoutMs = opts.readyTimeoutMs ?? COMPOSE_READY_TIMEOUT_MS
  const readyPollMs = opts.readyPollMs ?? COMPOSE_POLL_MS

  const inspectReady = async (id: string): Promise<boolean> => {
    const format =
      '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
    const result = await shell.run('docker', ['inspect', id, '--format', format], { cwd: opts.dir })
    if (result.code !== 0) return false
    const [status, health] = result.stdout.trim().split('|')
    // A service with no healthcheck configured can only be judged by `running`.
    return status === 'running' && (health === 'healthy' || health === 'none')
  }

  return {
    label: `${opts.service} (docker compose)`,
    async ensure() {
      const up = await shell.run('docker', ['compose', 'up', '-d', opts.service], {
        timeoutMs: 60_000,
        cwd: opts.dir,
      })
      if (up.code !== 0) return false

      const deadline = Date.now() + readyTimeoutMs
      while (Date.now() < deadline) {
        const ps = await shell.run('docker', ['compose', 'ps', '-q', opts.service], {
          cwd: opts.dir,
        })
        const id = ps.stdout.trim().split(/\r?\n/).filter(Boolean)[0]
        if (id && (await inspectReady(id))) return true
        await new Promise((resolve) => {
          setTimeout(resolve, readyPollMs)
        })
      }
      return false
    },
  }
}

/**
 * Frees the port before a restart. Killing the child tree usually suffices, but not always: a
 * package-manager wrapper that is killed without its subtree leaves the real `node` orphaned and
 * still holding the socket, and the relaunch then dies with `EADDRINUSE` — turning one outage into
 * a restart loop. Reaping by PORT is the only check that covers an orphan we never had a handle on.
 *
 * It is also, unavoidably, the bluntest thing this supervisor does: reaping by port means SIGKILLing
 * a process we were never handed. If `--port` names a port some unrelated service owns, that service
 * is what dies. There is no portable way to prove descent from our own child, so the mitigation is
 * disclosure rather than detection — every kill NAMES the pid and, where the platform will tell us,
 * the command behind it, and `reap()` reports what it killed so the caller can log it. Callers only
 * ever reap AFTER their own child is confirmed dead, so a healthy stack is never a candidate.
 */
export function createPortReaper(
  shell: HostShell,
  port: number,
  opts: { platform?: string; log?: (message: string) => void } = {},
): PortReaper {
  const isWindows = (opts.platform ?? process.platform) === 'win32'
  const log = opts.log ?? ((): void => {})

  /** Best-effort "what IS this pid", so a surprising kill is at least explicable after the fact. */
  const describe = async (pid: string): Promise<string> => {
    const result = isWindows
      ? await shell.run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'])
      : await shell.run('ps', ['-p', pid, '-o', 'command='])
    if (result.code !== 0) return `pid ${pid}`
    const text = result.stdout.trim().split(/\r?\n/)[0]?.trim()
    return text ? `pid ${pid} (${text})` : `pid ${pid}`
  }

  const listenerPids = async (): Promise<string[]> => {
    if (isWindows) {
      // Plain `netstat -ano` (not `-p tcp`, which is IPv4-only) so an IPv6-only listener is seen.
      const result = await shell.run('netstat', ['-ano'])
      if (result.code !== 0) {
        log(`⚠ cannot check port ${port}: netstat failed — an orphaned listener will not be reaped`)
        return []
      }
      const pids = new Set<string>()
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
        if (match && Number(match[1]) === port) pids.add(match[2] as string)
      }
      return [...pids]
    }
    const result = await shell.run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    // `lsof` exits 1 for "nothing matched", which is the common case and not worth a word. A MISSING
    // lsof is different: it is not installed by default on many Linux images, so the reaper silently
    // becomes a no-op and the EADDRINUSE restart loop it exists to prevent comes back unexplained.
    if (result.code === COMMAND_NOT_FOUND) {
      log(
        `⚠ cannot check port ${port}: lsof is not installed — an orphaned listener holding the ` +
          'port will not be reaped, so a restart may fail with EADDRINUSE',
      )
      return []
    }
    if (result.code !== 0) return []
    return [...new Set(result.stdout.split(/\s+/).filter(Boolean))]
  }

  return {
    async reap() {
      const killed: string[] = []
      for (const pid of await listenerPids()) {
        log(`↯ port ${port} is still held by ${await describe(pid)} — killing it`)
        // `/T` (Windows) kills the descendants too; elsewhere the group is signalled by the caller.
        if (isWindows) await shell.run('taskkill', ['/PID', pid, '/F', '/T'])
        else await shell.run('kill', ['-9', pid])
        killed.push(pid)
      }
      return killed
    },
  }
}

/**
 * Launches the supervised command through a shell, with stdio inherited so its logs stay visible —
 * the supervisor is meant to be a transparent wrapper, not a log proxy.
 *
 * The command is passed as ONE string with `shell: true` (rather than a command plus an args array,
 * which trips Node's DEP0190) so a package-manager entry point resolves through its Windows `.cmd`
 * shim. On POSIX the child gets its own process group, so killing it takes the whole tree.
 */
export function createChildLauncher(opts: { command: string; cwd: string }): ChildLauncher {
  const isWindows = process.platform === 'win32'

  return {
    start() {
      const child = spawn(opts.command, {
        cwd: opts.cwd,
        stdio: 'inherit',
        shell: true,
        detached: !isWindows,
      })

      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
        child.once('error', () => resolve({ code: null, signal: null }))
      })

      return {
        pid: child.pid,
        exited,
        async kill() {
          if (child.pid === undefined || child.exitCode !== null) return
          try {
            if (isWindows) {
              // No POSIX process groups on Windows; `taskkill /T` is what reaches the subtree.
              spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], {
                stdio: 'ignore',
              }).unref()
            } else {
              process.kill(-child.pid, 'SIGKILL')
            }
          } catch (err) {
            // silent-catch-ok: the child had already exited between the guard above and the signal
            // (ESRCH/EPERM). That is the outcome kill() is asking for, so there is nothing to report.
            void err
          }
          await Promise.race([
            exited,
            new Promise((resolve) => {
              setTimeout(resolve, 2_000)
            }),
          ])
        },
      }
    },
  }
}

/** Everything `runSupervisor` needs. Every field is a seam; only `launcher` and `probe` are required. */
export interface SupervisorDeps {
  config: SuperviseConfig
  probe: HealthProbe
  launcher: ChildLauncher
  /** Checked in order before each restart — e.g. the database, then the local cluster. */
  dependencies?: ServiceDependency[]
  reaper?: PortReaper
  clock?: SuperviseClock
  log?: (message: string) => void
  /**
   * Aborting stops the loop and, before returning, kills the supervised child and reaps the port.
   * The loop OWNS the child handle, so shutdown has to live here: a signal handler outside it can
   * only reach the port, which on POSIX kills the inner listener while leaving the package-manager
   * wrapper and its `node --watch` alive and parked — a Ctrl-C that orphans exactly the process tree
   * this command exists to manage.
   */
  stopSignal?: AbortSignal
  /** Stop after this many ticks — tests only; production runs until the process is signalled. */
  maxTicks?: number
}

/** How a finished supervisor run turned out. Useful for tests and for the command's exit code. */
export interface SupervisorOutcome {
  ticks: number
  repairs: number
  /** Dependencies that reported a state only an operator can clear, by label. */
  blocked: string[]
  /**
   * Outages the stack recovered from BY ITSELF — it stopped answering and came back with no repair
   * of ours in between, so something restarted it underneath us. Counted separately from `repairs`
   * because the two have opposite meanings for whoever is reading: a repair is the supervisor doing
   * its job, while an unexplained outage is a symptom of the supervised stack cycling on its own
   * (a `node --watch` file-change storm being the usual cause). A run that ends with several of
   * these looks perfectly healthy by every other measure, which is why the caller REPORTS this at
   * shutdown rather than only logging each occurrence: on a supervisor left running for days the
   * individual lines have long since scrolled away, and nothing else records that they happened.
   *
   * A recovery from the supervisor's OWN slow-binding child is deliberately not counted here (see
   * {@link RecoveryCause}); it is reported at the moment it happens and nowhere else, because the
   * remedy is a `--boot-grace` the reader is looking straight at.
   */
  unexplainedOutages: number
  /**
   * Set when the supervisor STOPPED trying, with the reason. Restarting cannot fix a command that
   * is simply broken, so `maxFailedStarts` consecutive restarts that never reached a serving state
   * end the loop and report — the caller turns this into a non-zero exit.
   */
  gaveUp?: string
}

/**
 * Run every dependency's `ensure`, logging each outcome. Returns the labels of any that need
 * operator action, whose guidance is printed only the first time so a long run doesn't bury it in
 * repeats. A blocked dependency does NOT abort the ladder: the supervised process is often still
 * worth restarting (a dead cluster breaks environment provisioning, not the whole backend).
 */
async function ensureDependencies(
  dependencies: ServiceDependency[],
  log: (message: string) => void,
  warned: Set<string>,
): Promise<string[]> {
  const blocked: string[] = []
  for (const dependency of dependencies) {
    try {
      const ready = await dependency.ensure()
      log(
        ready
          ? `✔ ${dependency.label} is ready`
          : `✖ ${dependency.label} is not ready — will retry next cycle`,
      )
    } catch (err) {
      if (!(err instanceof OperatorActionRequiredError)) throw err
      blocked.push(dependency.label)
      if (!warned.has(dependency.label)) {
        warned.add(dependency.label)
        log(`✖ ${dependency.label} NEEDS YOU: ${err.message}`)
      }
    }
  }
  return blocked
}

const RESTART_SETTLE_MS = 1_500

/**
 * Render a downtime for a human reading a scrolling log: `8.4s`, `1m 12s`. Sub-minute durations keep
 * a decimal because the interesting ones are short — a watch storm is over in seconds, and "8s" vs
 * "8.4s" is the difference between a rounded guess and a measurement.
 *
 * The unit is chosen from the SAME rounded value that gets rendered, never from the raw input.
 * Branching on the raw `ms` lets 59_980 take the sub-minute path and then round up inside it,
 * printing "60.0s": a duration in a unit this format explicitly stops at, which reads as a bug in
 * the measurement rather than in its rendering.
 */
export function formatDowntime(ms: number): string {
  const totalSeconds = Math.round(ms / 1_000)
  if (totalSeconds < 60) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`
}

/** Everything {@link reportRecovery} needs to turn one `recovered` action into log lines. */
interface RecoveryReport {
  log: (message: string) => void
  action: { afterFailures: number; downMs: number; cause: RecoveryCause }
  config: SuperviseConfig
  /**
   * Causes whose explanatory hint has already been printed. The warn-once rule
   * {@link ensureDependencies} follows, applied per cause so a flapping stack does not bury its own
   * diagnosis in repeats — and so a later slow start still gets its own explanation rather than
   * inheriting the silence earned by an unrelated outage.
   */
  hinted: Set<RecoveryCause>
  unexplainedOutages: number
}

/**
 * Report a recovery, and return the new running count of outages we did NOT cause.
 *
 * Both causes arrive here as the same `recovered` action and they must not be reported the same
 * way, because they are opposite claims about who caused the gap. Only `'unexplained'` is an
 * outage: the stack had already answered under this child, then stopped, then came back with no
 * repair of ours in between, so something restarted it underneath us. That one leaves no other
 * trace (nothing crashed, every process is still alive, `/health` answers again by the time anyone
 * looks), which is why it is a warning with a running count instead of the bland success it used
 * to log.
 *
 * `'slow-start'` is the supervisor watching its OWN child bind late: reported, because the grace
 * window is mistuned and a few more missed probes would have restarted a boot that was about to
 * succeed, but never counted as an outage and never attributed to a third party. Collapsing the two
 * is the misdiagnosis this whole report exists to prevent — it would turn every cold boot slower
 * than `--boot-grace`, and every repair whose restart is, into `no repair of ours caused it`.
 *
 * Every duration is qualified with the poll interval it was measured against. Both ends of the
 * window are quantized to that interval and the errors point in opposite directions, so the number
 * is the truth ± one poll: at the default 10s poll a 100ms blip can render as a full 10s, and a
 * reader given `19.3s` with no resolution beside it has no way to know that.
 */
function reportRecovery(report: RecoveryReport): number {
  const { log, action, config, hinted, unexplainedOutages } = report
  const span = formatDowntime(action.downMs)
  // Trails the duration in both wordings: the resolution has to sit where the number is read, not
  // in a legend somewhere else, or `19.3s` is taken for a measurement rather than a bucket.
  const qualifier =
    `, give or take the ${config.pollMs / 1_000}s poll interval ` +
    `(${action.afterFailures} failed probe(s))`
  const hint = (message: string): void => {
    if (hinted.has(action.cause)) return
    hinted.add(action.cause)
    log(`  ↳ ${message}`)
  }

  switch (action.cause) {
    case 'unexplained': {
      const count = unexplainedOutages + 1
      log(
        `⚠ serving again after ${span} down since the first failed probe${qualifier} — ` +
          `unexplained outage #${count}, no repair of ours caused it`,
      )
      hint(
        'something restarted the stack underneath the supervisor. On a `node --watch` ' +
          'deployment this is usually a file-change storm: the watcher cycles the server several ' +
          'times, the port is unbound for a few seconds, and any client mid-request fails with ' +
          'ECONNREFUSED while nothing crashes. Check the server log for repeated "Restarting" ' +
          'lines with no error between them.',
      )
      return count
    }
    case 'slow-start': {
      log(
        `⚠ serving after a slow start: ${span} past the boot grace window${qualifier} — ` +
          'our own start finishing late, not an outage',
      )
      hint(
        'the stack had not answered once since the supervisor started it, so nothing cycled ' +
          `underneath us: the boot simply outran --boot-grace (${config.bootGraceMs / 1_000}s). ` +
          `${action.afterFailures} of the ${config.failureThreshold} failed probes needed to ` +
          'restart it were already on the clock, so raise --boot-grace if this stack is normally ' +
          'this slow to bind.',
      )
      return unexplainedOutages
    }
    default: {
      // Exhaustiveness: a new `RecoveryCause` must state how it is reported rather than
      // inheriting whichever branch happens to sit last. Falling through to the outage wording
      // would re-create the exact misattribution this function was split up to end.
      const unreachable: never = action.cause
      throw new Error(`unhandled recovery cause: ${String(unreachable)}`)
    }
  }
}

/**
 * Run the supervision loop: start the child, then probe on an interval and repair when the
 * decisions in `supervise.ts` say so. Returns when `stopSignal` aborts, when the crash-loop budget
 * is spent, or when `maxTicks` is reached (tests) — in production, otherwise never.
 */
export async function runSupervisor(deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const clock = deps.clock ?? systemClock
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const { config, stopSignal } = deps

  let repairs = 0
  let ticks = 0
  let blocked: string[] = []
  let gaveUp: string | undefined
  let unexplainedOutages = 0
  const warned = new Set<string>()
  const hinted = new Set<RecoveryCause>()

  // A child that has exited is a fact the probe can only infer, slowly. Tracked per generation so a
  // dead PREDECESSOR's late `exited` can never be read as the current child having died.
  let generation = 0
  let childExited = false
  const startChild = (): SupervisedChild => {
    const mine = ++generation
    childExited = false
    const started = deps.launcher.start()
    void started.exited.then(() => {
      if (mine === generation) childExited = true
    })
    return started
  }

  let child = startChild()
  let state = initialState(clock.now(), config)

  // Restarts that have not yet produced a serving stack. Reset by any successful probe, so this
  // counts a genuine crash loop rather than a long-lived stack that has been repaired often.
  let failedStarts = 0

  const restart = async (): Promise<void> => {
    await child.kill()
    await clock.sleep(RESTART_SETTLE_MS)
    // Reap AFTER killing the tree: this only catches an orphan the tree kill could not reach. Our
    // own child is dead by now, so anything still on the port is by definition not it.
    if (deps.reaper) await deps.reaper.reap()
    child = startChild()
    state = stateAfterStart(clock.now(), config)
  }

  // Read through a function, not inline: `signal.aborted` flips underneath us, and a direct
  // comparison in the loop condition would let the compiler narrow it to `false` for the body.
  const stopRequested = (): boolean => stopSignal?.aborted === true

  while (
    !stopRequested() &&
    gaveUp === undefined &&
    (deps.maxTicks === undefined || ticks < deps.maxTicks)
  ) {
    await clock.sleep(config.pollMs, stopSignal)
    if (stopRequested()) break
    ticks += 1

    // Sampled BEFORE the probe: the probe can take seconds against a filtered port, and folding
    // that into the drift would read as a suspend (see `clockJumpMs`).
    const now = clock.now()
    const serving = await deps.probe.serving()
    if (serving) failedStarts = 0
    const next = step(state, { now, serving, childExited }, config)
    state = next.state
    const { action } = next

    switch (action.kind) {
      case 'serving':
      case 'grace':
        break
      case 'resumed':
        log(`✔ resumed after ${Math.round(action.driftMs / 1000)}s — the stack is still serving`)
        break
      case 'recovered':
        unexplainedOutages = reportRecovery({ log, action, config, hinted, unexplainedOutages })
        break
      case 'counting':
        log(`• health probe failed (${action.failures}/${action.threshold})`)
        break
      case 'repair': {
        repairs += 1
        failedStarts += 1
        log(`⚠ not serving — ${action.reason}; repair #${repairs}`)
        if (failedStarts > config.maxFailedStarts) {
          // Reported, not retried — the same rule the wedged-cgroup path follows. A command that has
          // never once served is not going to start serving because we killed it again.
          gaveUp =
            `the supervised command has failed to serve ${failedStarts} starts in a row. ` +
            'Restarting cannot fix a command that is broken — run it directly to see why ' +
            '(in deploy/local: `pnpm dev:raw`).'
          log(`✖ GIVING UP: ${gaveUp}`)
          break
        }
        if (deps.dependencies?.length) {
          blocked = await ensureDependencies(deps.dependencies, log, warned)
        }
        await restart()
        log('↻ restarted the supervised command')
        break
      }
    }
  }

  // Shutdown is the loop's job because the loop owns the child handle.
  await child.kill()
  if (deps.reaper) {
    const killed = await deps.reaper.reap()
    if (killed.length > 0) log(`↯ reaped ${killed.length} orphaned listener(s) on shutdown`)
  }

  return { ticks, repairs, blocked, gaveUp, unexplainedOutages }
}
