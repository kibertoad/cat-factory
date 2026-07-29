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
import type { HostShell } from './host-shell.js'
import { initialState, type SuperviseConfig, stateAfterStart, step } from './supervise.js'

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
  reap(): Promise<void>
}

/** Injectable clock, so tests never wait in real time. */
export interface SuperviseClock {
  now(): number
  sleep(ms: number): Promise<void>
}

/**
 * NOTE the deliberately un-`unref`'d timers throughout this module. An `unref`'d timer does not keep
 * the event loop alive, and while a spawned child DOES hold it open, that reference vanishes the
 * moment the child dies — which is precisely when the supervisor must keep running. With `unref` the
 * poll timer was then the only thing left, so Node exited 0 the instant its child was killed: a
 * watchdog that died with its patient, silently and with a success code.
 */
export const systemClock: SuperviseClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
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
  opts: { dir: string; service: string },
): ServiceDependency {
  const inspectReady = async (id: string): Promise<boolean> => {
    const format =
      '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
    const result = await shell.run('docker', ['inspect', id, '--format', format])
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
      })
      if (up.code !== 0) return false

      const deadline = Date.now() + COMPOSE_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        const ps = await shell.run('docker', ['compose', 'ps', '-q', opts.service])
        const id = ps.stdout.trim().split(/\r?\n/).filter(Boolean)[0]
        if (id && (await inspectReady(id))) return true
        await new Promise((resolve) => {
          setTimeout(resolve, COMPOSE_POLL_MS)
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
 */
export function createPortReaper(shell: HostShell, port: number): PortReaper {
  const isWindows = process.platform === 'win32'

  const listenerPids = async (): Promise<string[]> => {
    if (isWindows) {
      // Plain `netstat -ano` (not `-p tcp`, which is IPv4-only) so an IPv6-only listener is seen.
      const result = await shell.run('netstat', ['-ano'])
      if (result.code !== 0) return []
      const pids = new Set<string>()
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
        if (match && Number(match[1]) === port) pids.add(match[2] as string)
      }
      return [...pids]
    }
    const result = await shell.run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    if (result.code !== 0) return []
    return [...new Set(result.stdout.split(/\s+/).filter(Boolean))]
  }

  return {
    async reap() {
      for (const pid of await listenerPids()) {
        // `/T` (Windows) kills the descendants too; elsewhere the group is signalled by the caller.
        if (isWindows) await shell.run('taskkill', ['/PID', pid, '/F', '/T'])
        else await shell.run('kill', ['-9', pid])
      }
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
  /** Stop after this many ticks — tests only; production runs until the process is signalled. */
  maxTicks?: number
}

/** How a finished supervisor run turned out. Useful for tests and for the command's exit code. */
export interface SupervisorOutcome {
  ticks: number
  repairs: number
  /** Dependencies that reported a state only an operator can clear, by label. */
  blocked: string[]
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
 * Run the supervision loop: start the child, then probe on an interval and repair when the
 * decisions in `supervise.ts` say so. Returns when `maxTicks` is reached (tests) or never
 * (production, until the process is signalled).
 */
export async function runSupervisor(deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const clock = deps.clock ?? systemClock
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const { config } = deps

  let child = deps.launcher.start()
  let state = initialState(clock.now(), config)
  let repairs = 0
  let ticks = 0
  let blocked: string[] = []
  const warned = new Set<string>()

  const restart = async (): Promise<void> => {
    await child.kill()
    await clock.sleep(RESTART_SETTLE_MS)
    // Reap AFTER killing the tree: this only catches an orphan the tree kill could not reach.
    if (deps.reaper) await deps.reaper.reap()
    child = deps.launcher.start()
    state = stateAfterStart(clock.now(), config, state)
  }

  while (deps.maxTicks === undefined || ticks < deps.maxTicks) {
    await clock.sleep(config.pollMs)
    ticks += 1

    const serving = await deps.probe.serving()
    const next = step(state, { now: clock.now(), serving }, config)
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
        log(`✔ serving again (after ${action.afterFailures} failed probe(s))`)
        break
      case 'counting':
        log(`• health probe failed (${action.failures}/${action.threshold})`)
        break
      case 'repair': {
        repairs += 1
        log(`⚠ not serving — ${action.reason}; repair #${repairs}`)
        if (deps.dependencies?.length) {
          blocked = await ensureDependencies(deps.dependencies, log, warned)
        }
        await restart()
        log('↻ restarted the supervised command')
        break
      }
    }
  }

  return { ticks, repairs, blocked }
}
