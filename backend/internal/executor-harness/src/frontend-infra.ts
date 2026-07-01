import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FrontendInfraSpec, InfraSetupRecord } from './job.js'
import { killChildProcess } from './process.js'
import { pathExists } from './fs-utils.js'
import { captureRedactedOutput, redactSecrets } from './redact.js'
import { log, type Logger } from './logger.js'

const exec = promisify(execFile)

// The self-contained frontend UI-test stand-up (the `tester-ui` flow). In ONE container we
// build the frontend, stand WireMock up for its mocked upstreams, serve the built app, and
// point the agent at it — all as localhost PROCESSES (no Docker-in-Docker), so it works on
// Cloudflare and Apple `container` too. The backend has already resolved every upstream to a
// concrete URL and handed them in `infra.env`; this file only builds/serves/mocks. WireMock
// standalone (the jar at `$WIREMOCK_JAR`) and a static file server (`serve`) plus the package
// managers are provided by the UI image (Dockerfile.ui).

/** Where the WireMock standalone jar lives in the image (overridable for tests). */
const WIREMOCK_JAR = process.env.WIREMOCK_JAR ?? '/opt/wiremock/wiremock-standalone.jar'

/** Defaults the backend may omit; kept here so the harness owns the runtime shape. */
const DEFAULTS = {
  packageManager: 'pnpm' as const,
  buildScript: 'build',
  outputDir: 'dist',
  serveMode: 'static' as const,
  servePort: 4173,
  envInjection: 'build' as const,
  mockMappingsPath: 'mocks/',
  wiremockPort: 8089,
}

export interface FrontendStandUp {
  /** The processes to terminate on teardown (WireMock + the served app). */
  processes: ChildProcess[]
  /** The URL the built app is served at, when it came up. Folded into the agent prompt. */
  serveUrl?: string
  /** A problem note folded into the agent prompt (a failed build / server that never bound). */
  note?: string
  /** The captured (redacted, bounded) stand-up record surfaced on the Tester step. */
  record: InfraSetupRecord
}

/** The install command for a package manager (an explicit `install` overrides this). */
function installCommand(spec: FrontendInfraSpec): string[] {
  if (spec.install) return spec.install.split(/\s+/).filter(Boolean)
  const pm = spec.packageManager ?? DEFAULTS.packageManager
  return [pm, 'install']
}

/**
 * Attach an `'error'` listener to a spawned background process. A `ChildProcess` is an
 * EventEmitter, and an `'error'` event with NO listener (an ENOENT for a missing binary, an
 * EAGAIN/ENOMEM under the container's memory limit) is re-thrown by Node as an UNCAUGHT
 * exception that would kill the whole harness job server. The frontend stand-up is
 * best-effort, so we swallow the error into the log instead — a dead WireMock / server is
 * then caught by the health-check and surfaced as a prompt note, not a container crash.
 */
function guardProcess(child: ChildProcess, label: string, logger: Logger): ChildProcess {
  child.on('error', (err) => {
    logger.warn(`agent(frontend): ${label} process error`, {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  return child
}

/**
 * Build the frontend, start WireMock, serve the built app and health-check both. Best-effort,
 * like the docker-compose stand-up: a failed build / server that never binds is surfaced to
 * the agent as a prompt note (and captured on the record) rather than failing the job — the
 * agent then reports the gap as a concern. Every path returns the processes to tear down.
 */
export async function standUpFrontend(
  dir: string,
  infra: FrontendInfraSpec,
  signal: AbortSignal | undefined,
  logger: Logger = log,
): Promise<FrontendStandUp> {
  const startedAt = Date.now()
  const processes: ChildProcess[] = []
  const servePort = infra.servePort ?? DEFAULTS.servePort
  const wiremockPort = infra.wiremockPort ?? DEFAULTS.wiremockPort
  const serveUrl = `http://localhost:${servePort}`
  // Raw (un-redacted) stage output; redacted+bounded ONCE when a record is built.
  const rawOutput: string[] = []
  const pushOutput = (stdout: unknown, stderr: unknown): void => {
    const merged = [String(stdout ?? ''), String(stderr ?? '')]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n')
    if (merged) rawOutput.push(merged)
  }
  const record = (extra: Partial<InfraSetupRecord>): InfraSetupRecord => {
    const logs = rawOutput.length ? captureRedactedOutput(rawOutput.join('\n'), '') : undefined
    return {
      started: false,
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      ...(logs ? { logs } : {}),
      ...extra,
    }
  }

  const buildEnv =
    (infra.envInjection ?? DEFAULTS.envInjection) === 'build' ? (infra.env ?? {}) : {}

  try {
    // 1) Install dependencies.
    const install = installCommand(infra)
    logger.info('agent(frontend): installing', { command: install.join(' ') })
    const installed = await exec(install[0]!, install.slice(1), {
      cwd: dir,
      signal,
      timeout: 8 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    pushOutput(installed.stdout, installed.stderr)

    // 2) Build (build-time env injected here; runtime injection writes a shim after).
    const pm = infra.packageManager ?? DEFAULTS.packageManager
    const buildScript = infra.buildScript ?? DEFAULTS.buildScript
    logger.info('agent(frontend): building', { buildScript })
    const built = await exec(pm, ['run', buildScript], {
      cwd: dir,
      signal,
      timeout: 12 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...buildEnv },
    })
    pushOutput(built.stdout, built.stderr)

    // Runtime injection: write a `window.env` shim into the build output the app can load
    // (`<outputDir>/env.js`). Best-effort — the app must reference it; a build-time app ignores it.
    const outputDir = infra.outputDir ?? DEFAULTS.outputDir
    if ((infra.envInjection ?? DEFAULTS.envInjection) === 'runtime' && infra.env) {
      const shim = `window.env = ${JSON.stringify(infra.env)};\n`
      await writeFile(join(dir, outputDir, 'env.js'), shim, 'utf8').catch(() => {})
    }

    // 3) WireMock for the mocked upstreams. Seeded from the FE repo's mappings dir when present;
    // otherwise it still binds the port (unmatched requests 404, gentler than ECONNREFUSED).
    processes.push(await startWireMock(dir, infra, wiremockPort, logger))

    // 4) Serve the built app.
    processes.push(startServe(dir, infra, servePort, outputDir, logger))

    // 5) Health-check the served app AND WireMock before handing off, concurrently (WireMock is
    // a JVM that cold-starts slower than the static server). A dead WireMock would otherwise let
    // the agent start and hit ECONNREFUSED on the app's first mocked-upstream call.
    const wiremockUrl = `http://localhost:${wiremockPort}/__admin/`
    const [appHealthy, wiremockHealthy] = await Promise.all([
      waitForHttp(serveUrl, signal, logger),
      waitForHttp(wiremockUrl, signal, logger),
    ])
    if (!appHealthy) {
      return {
        processes,
        note: `the frontend was built but its server never became reachable at ${serveUrl}`,
        record: record({ error: `frontend server did not become reachable at ${serveUrl}` }),
      }
    }
    if (!wiremockHealthy) {
      // The app is up but the mock upstream isn't — the agent can still smoke-test the app;
      // flag that mocked-backend calls may fail so it reports the gap rather than treating a
      // mock ECONNREFUSED as a real defect.
      return {
        processes,
        serveUrl,
        note:
          `the frontend is served at ${serveUrl}, but WireMock (the mock for its other backend ` +
          `upstreams) never became reachable on port ${wiremockPort}, so calls to mocked ` +
          `upstreams may fail — flag any such failures as an infra gap, not an app defect`,
        record: record({
          started: true,
          error: `WireMock did not become reachable on port ${wiremockPort}`,
        }),
      }
    }
    logger.info('agent(frontend): app is serving', { serveUrl, wiremockPort })
    return {
      processes,
      serveUrl,
      record: record({ started: true }),
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    logger.warn('agent(frontend): stand-up failed', { error: note })
    const e = err as { stdout?: unknown; stderr?: unknown }
    pushOutput(e.stdout, e.stderr)
    return { processes, note, record: record({ error: redactSecrets(note) }) }
  }
}

/** Terminate the frontend stand-up's processes (WireMock + the served app). Best-effort. */
export async function tearDownFrontend(
  processes: ChildProcess[],
  logger: Logger = log,
): Promise<void> {
  for (const child of processes) {
    try {
      killChildProcess(child, undefined, logger)
    } catch {
      // The container is ephemeral and torn down with the run anyway — ignore.
    }
  }
}

/**
 * Start WireMock standalone as a background process on `wiremockPort`, seeded from the FE
 * repo's mappings dir (`mockMappingsPath`, WireMock's `--root-dir`) when it exists. A missing
 * jar / JRE surfaces asynchronously as a process `'error'` (swallowed by {@link guardProcess})
 * and is then caught by the caller's WireMock health-check; a missing mappings dir is non-fatal
 * (WireMock still binds the port and 404s unmatched requests).
 */
async function startWireMock(
  dir: string,
  infra: FrontendInfraSpec,
  wiremockPort: number,
  logger: Logger,
): Promise<ChildProcess> {
  const mappingsPath = infra.wiremockMappingsPath ?? DEFAULTS.mockMappingsPath
  const rootDir = join(dir, mappingsPath)
  const hasMappings = await pathExists(rootDir)
  const args = ['-jar', WIREMOCK_JAR, '--port', String(wiremockPort), '--disable-banner']
  if (hasMappings) args.push('--root-dir', rootDir)
  else logger.warn('agent(frontend): no WireMock mappings dir, starting empty', { mappingsPath })
  logger.info('agent(frontend): starting WireMock', { wiremockPort, hasMappings })
  return guardProcess(spawn('java', args, { cwd: dir, stdio: 'ignore' }), 'WireMock', logger)
}

/**
 * Serve the built app on `servePort`: a static file server of `outputDir` (`static` mode), or
 * the FE's own serve script (`command` mode, e.g. `preview`). In `command` mode the port is
 * passed as the `PORT` env var, so the script MUST honour it (else it binds its own default
 * port and the health-check — which polls `servePort` — never sees it). Returns the background
 * process. The static server (`serve`) is provided by the UI image.
 */
function startServe(
  dir: string,
  infra: FrontendInfraSpec,
  servePort: number,
  outputDir: string,
  logger: Logger,
): ChildProcess {
  const mode = infra.serveMode ?? DEFAULTS.serveMode
  if (mode === 'command' && infra.serveScript) {
    const pm = infra.packageManager ?? DEFAULTS.packageManager
    logger.info('agent(frontend): serving via script', {
      serveScript: infra.serveScript,
      servePort,
    })
    return guardProcess(
      spawn(pm, ['run', infra.serveScript], {
        cwd: dir,
        stdio: 'ignore',
        env: { ...process.env, PORT: String(servePort) },
      }),
      'serve',
      logger,
    )
  }
  logger.info('agent(frontend): serving static output', { outputDir, servePort })
  // `serve -s` single-page fallback so a client-routed SPA resolves deep links to index.html.
  return guardProcess(
    spawn('serve', ['-s', outputDir, '-l', String(servePort)], { cwd: dir, stdio: 'ignore' }),
    'serve',
    logger,
  )
}

/** Poll a URL until it answers (any HTTP status) or the timeout elapses. */
async function waitForHttp(
  url: string,
  signal: AbortSignal | undefined,
  logger: Logger,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      // Any response (even a 404) means the server is up and accepting connections.
      if (res.status > 0) return true
    } catch {
      // Not up yet — back off and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  logger.warn('agent(frontend): health-check timed out', { url, timeoutMs })
  return false
}
