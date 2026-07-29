/**
 * `cat-factory supervise` — wire the real effects into the supervision loop.
 *
 * Thin on purpose: the judgement lives in `supervise.ts`, the effects in `supervise-runtime.ts`.
 * This resolves flags into a config, builds the process/socket/shell-backed seams, prints what it
 * is about to watch, and hands over to `runSupervisor`.
 */

import { resolve } from 'node:path'
import { ArgError, type CliOptions, OPTION_DEFAULTS } from './args.js'
import { createNodeShell } from './host-shell.js'
import { createK3sClusterDependency } from './supervise-k3s.js'
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
 * Re-quote a token that contains whitespace. The child is launched as one shell string (see
 * `createChildLauncher`), so a path with a space in it would otherwise split into two arguments —
 * `C:\Program Files\nodejs\node.exe` being the case that matters on Windows.
 *
 * Deliberately NOT `JSON.stringify`: that escapes backslashes (`C:\\Program Files\\…`), which no
 * shell unescapes, so the quoted path becomes a path that does not exist. Only the surrounding
 * quotes and any embedded quote need handling.
 */
export function quoteToken(token: string): string {
  if (token === '') return '""'
  if (!/[\s"]/.test(token)) return token
  return `"${token.replace(/"/g, '\\"')}"`
}

export async function supervise(options: CliOptions): Promise<void> {
  const argv = options.superviseCommand ?? []
  if (argv.length === 0) {
    throw new ArgError(
      'supervise needs a command to run, after `--`\n' +
        '  e.g. cat-factory supervise --port 8787 -- pnpm dev',
    )
  }

  const command = argv.map(quoteToken).join(' ')
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
        runtime: options.k3sRuntime === 'kind' ? 'kind' : 'k3d',
      }),
    )
  }

  const launcher = createChildLauncher({ command, cwd })
  const probe = createHealthProbe({ port, healthPath })
  const reaper = createPortReaper(shell, port)

  const log = (message: string): void => {
    process.stdout.write(`[supervise] ${message}\n`)
  }

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

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    log('shutting down')
    // The loop's child handle is not reachable from here; reaping the port is what guarantees the
    // real listener dies with us rather than lingering to block the next start.
    void reaper.reap().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await runSupervisor({ config, probe, launcher, dependencies, reaper, log })
}
