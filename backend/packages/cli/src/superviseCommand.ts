/**
 * `cat-factory supervise` — wire the real effects into the supervision loop.
 *
 * Thin on purpose: the judgement lives in `supervise.ts`, the effects in `supervise-runtime.ts`.
 * This resolves flags into a config, builds the process/socket/shell-backed seams, prints what it
 * is about to watch, and hands over to `runSupervisor`.
 */

import { resolve } from 'node:path'
import { ArgError, type CliOptions, type K3sRuntime, OPTION_DEFAULTS } from './args.js'
import { createNodeShell } from './host-shell.js'
import { createK3sClusterDependency, type SupervisedK3sRuntime } from './supervise-k3s.js'
import {
  createChildLauncher,
  createComposeDependency,
  createHealthProbe,
  createPortReaper,
  OperatorActionRequiredError,
  runSupervisor,
  type ServiceDependency,
} from './supervise-runtime.js'
import { resolveSuperviseConfig } from './supervise.js'

/**
 * Local wall-clock `HH:MM:SS` for a log prefix. Local rather than UTC on purpose: the reader is
 * comparing these lines against a server log in the same terminal and against their own memory of
 * when something broke, both of which are in local time.
 */
export function timestamp(at: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * Re-quote a token that contains whitespace. The child is launched as one shell string (see
 * `createChildLauncher`), so a path with a space in it would otherwise split into two arguments —
 * `C:\Program Files\nodejs\node.exe` being the case that matters on Windows.
 *
 * Deliberately NOT `JSON.stringify`: that escapes backslashes (`C:\\Program Files\\…`), which no
 * shell unescapes, so the quoted path becomes a path that does not exist. Only the surrounding
 * quotes and any embedded quote need handling.
 *
 * The escape for an embedded quote is platform-specific, because `shell: true` means a genuinely
 * different shell on each side: `cmd.exe` does not honour a backslash escape at all (it would pass
 * the backslash through and treat the quote as closing the argument), and doubles the quote instead.
 * `platform` is injectable so both dialects are testable from either host.
 */
export function quoteToken(token: string, platform: string = process.platform): string {
  if (token === '') return '""'
  if (!/[\s"]/.test(token)) return token
  const escaped =
    platform === 'win32' ? token.replace(/"/g, '""') : token.replace(/"/g, String.raw`\"`)
  return `"${escaped}"`
}

/**
 * Narrow the shared `--runtime` picklist to what a supervisor can actually start, REFUSING the
 * third member rather than quietly treating it as k3d. `k3s` proper is a host service (systemd), not
 * a set of containers this command owns, so it has no `cluster start` to call. Degrading silently
 * would leave `k3d cluster list` never listing the cluster, so the dependency would report "not
 * ready — will retry next cycle" on every cycle forever, with nothing naming the real reason.
 */
function supervisedRuntime(runtime: K3sRuntime | undefined): SupervisedK3sRuntime {
  if (runtime === undefined) return 'k3d'
  if (runtime === 'k3d' || runtime === 'kind') return runtime
  throw new ArgError(
    `--runtime ${runtime} cannot be supervised: a k3s host service has no cluster for this command ` +
      'to start. Use --runtime k3d or --runtime kind, or drop --k3s-cluster.',
  )
}

export async function supervise(options: CliOptions): Promise<void> {
  const argv = options.superviseCommand ?? []
  if (argv.length === 0) {
    throw new ArgError(
      'supervise needs a command to run, after `--`\n' +
        '  e.g. cat-factory supervise --port 8787 -- pnpm dev',
    )
  }

  // Not `argv.map(quoteToken)`: `map` would pass the index as the platform argument.
  const command = argv.map((token) => quoteToken(token)).join(' ')
  const cwd = options.dir ? resolve(options.dir) : process.cwd()
  const port = options.port ?? OPTION_DEFAULTS.port
  const healthPath = options.healthPath ?? OPTION_DEFAULTS.healthPath

  const config = resolveSuperviseConfig({
    pollMs: options.pollSeconds !== undefined ? options.pollSeconds * 1_000 : undefined,
    bootGraceMs:
      options.bootGraceSeconds !== undefined ? options.bootGraceSeconds * 1_000 : undefined,
    failureThreshold: options.failures,
  })

  const shell = createNodeShell()

  // Only wire the dependencies that were named — the supervisor is useful with none at all. Order
  // matters: the database comes first because the server dies in `migrate` without it, while a dead
  // cluster only breaks environment provisioning.
  const dependencies: ServiceDependency[] = []
  if (options.composeService) {
    dependencies.push(
      createComposeDependency(shell, {
        dir: options.composeDir ? resolve(options.composeDir) : cwd,
        service: options.composeService,
      }),
    )
  }
  if (options.k3sCluster) {
    dependencies.push(
      createK3sClusterDependency(shell, {
        cluster: options.k3sCluster,
        runtime: supervisedRuntime(options.k3sRuntime),
      }),
    )
  }

  const launcher = createChildLauncher({ command, cwd })
  const probe = createHealthProbe({ port, healthPath })

  // Timestamped, because these lines are read INTERLEAVED with the supervised server's own output
  // and are usually the only record of a transient outage. The supervised stack logs structured
  // lines with their own timestamps; untimestamped supervisor lines could not be placed against
  // them, so reconstructing when a stack was actually down meant interpolating from whatever
  // neighbouring line happened to carry a clock. Local wall-clock time to the second matches what
  // the reader sees elsewhere in the same terminal.
  const log = (message: string): void => {
    process.stdout.write(`[supervise ${timestamp()}] ${message}\n`)
  }

  const reaper = createPortReaper(shell, port, { log })

  log(
    `watching :${port}${healthPath} every ${config.pollMs / 1_000}s — ` +
      `repairs after ${config.failureThreshold} failed probes or a detected resume`,
  )
  for (const dependency of dependencies) log(`dependency: ${dependency.label}`)
  log(`command: ${command}`)

  // Bring the dependencies up BEFORE the first start, so a cold `pnpm dev:safe` on a machine whose
  // engine was restarted doesn't spend its first boot crashing against a stopped database.
  for (const dependency of dependencies) {
    try {
      const ready = await dependency.ensure()
      log(
        ready
          ? `✔ ${dependency.label} is ready`
          : `✖ ${dependency.label} is not ready — starting anyway`,
      )
    } catch (err) {
      if (!(err instanceof OperatorActionRequiredError)) throw err
      log(`✖ ${dependency.label} NEEDS YOU: ${err.message}`)
    }
  }

  // Shutdown is delegated to the loop, which owns the child handle: aborting makes it break out of
  // its sleep, kill the child TREE, and reap the port. Reaping from here instead would kill the
  // inner listener while leaving the package-manager wrapper and its parked `node --watch` alive.
  const stopper = new AbortController()
  const stop = (): void => {
    if (stopper.signal.aborted) return
    log('shutting down')
    stopper.abort()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const outcome = await runSupervisor({
    config,
    probe,
    launcher,
    dependencies,
    reaper,
    log,
    stopSignal: stopper.signal,
  })

  // The one place an unexplained outage is still readable after the fact. Nothing crashed while it
  // happened, so it leaves no trace in the supervised stack's own log, and on a supervisor left
  // running for days the warning that named it has long since scrolled away. Repairs are summarised
  // beside it because the contrast is the point: repairs are the supervisor working, unexplained
  // outages are the stack cycling on its own.
  log(
    `stopped after ${outcome.ticks} probe(s): ${outcome.repairs} repair(s), ` +
      `${outcome.unexplainedOutages} unexplained outage(s)`,
  )
  if (outcome.unexplainedOutages > 0) {
    log(
      '  ↳ the stack went down and came back on its own; nothing this supervisor did caused those. ' +
        'Scroll back for the first one, which carries the likely cause.',
    )
  }

  // A supervisor that stopped because the command is broken must not report success — a wrapper
  // exiting 0 on a dead stack is the failure shape this whole command exists to make impossible.
  if (outcome.gaveUp !== undefined) process.exitCode = 1
}
