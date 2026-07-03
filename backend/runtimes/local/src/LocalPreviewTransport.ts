import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import type { LocalSettings } from '@cat-factory/contracts'
import {
  PREVIEW_HARNESS_JOB_ID,
  type PreviewRef,
  type PreviewTransport,
  type PreviewView,
} from '@cat-factory/kernel'
import {
  EVICTION_ERROR,
  type HarnessEndpoint,
  delay,
  harnessUrl,
  pollHarnessJob,
  postHarnessJob,
  waitForHarnessHealth,
} from './harnessHttp.js'
import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerRuntimeAdapter,
  createRuntimeAdapter,
  DockerRuntimeAdapter,
} from './runtimes/index.js'
import { harnessAllowedHosts } from './github.js'
import { resolveHarnessImage } from './harnessImage.js'

const execFileAsync = promisify(execFile)

/**
 * The browsable-frontend-PREVIEW container transport (slice 5c) — the local/node analogue of
 * {@link LocalContainerRunnerTransport} for a LONG-LIVED serve. Unlike a per-run agent container
 * (reclaimed when the run finishes), a preview container:
 *   - publishes the served app's port to an ephemeral HOST port (a SECOND `-p` alongside the
 *     harness `:8080`, read back with `docker port` — the browsable URL is formed from it), and
 *   - is NOT stopped until an explicit {@link stop} (the served processes outlive the build job,
 *     exactly as the harness `preview` mode leaves them running).
 *
 * It reuses the SAME container-runtime adapter (Docker/Podman/OrbStack/Colima/Apple) + harness
 * HTTP protocol as the runner transport, so a runtime change is made once. A preview is keyed by
 * its `frontend` frame: the container is labelled with a synthetic `preview-<frameId>` run id and
 * runs a single harness job ({@link PREVIEW_HARNESS_JOB_ID}).
 */
export interface LocalPreviewTransportOptions {
  image: string
  adapter?: ContainerRuntimeAdapter
  sharedSecret?: string
  network?: string
  env?: Record<string, string>
  exec?: ContainerExec
  fetchImpl?: typeof fetch
  readyTimeoutMs?: number
  requestTimeoutMs?: number
}

/** The synthetic run id a preview container is labelled with (keyed by its frontend frame). */
function previewRunId(frameId: string): string {
  return `preview-${frameId}`
}

/**
 * Whether a container-runtime error is a host-port bind collision (Docker/Podman phrase it a
 * few ways). Used to translate a pinned-preview `-p` failure into an actionable message.
 */
function isHostPortInUseError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('port is already allocated') ||
    message.includes('address already in use') ||
    message.includes('ports are not available')
  )
}

function defaultExec(binary: string): ContainerExec {
  return async (args) => {
    try {
      return await execFileAsync(binary, args, { maxBuffer: 16 * 1024 * 1024 })
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const reason = (e.stderr ?? '').trim() || (e.message ?? '').trim() || 'unknown error'
      throw new Error(`\`${binary} ${args[0] ?? ''}\` failed: ${reason}`)
    }
  }
}

export class LocalPreviewTransport implements PreviewTransport {
  private readonly adapter: ContainerRuntimeAdapter
  private readonly image: string
  private readonly sharedSecret: string
  private readonly network?: string
  private readonly extraEnv: Record<string, string>
  private readonly exec: ContainerExec
  private readonly fetchImpl: typeof fetch
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number

  /** frameId → the running preview's container + its in-container served-app port. */
  private readonly cache = new Map<string, { containerId: string; servePort: number }>()

  constructor(options: LocalPreviewTransportOptions) {
    this.adapter =
      options.adapter ??
      new DockerRuntimeAdapter({
        id: 'docker',
        binary: 'docker',
        hostAlias: 'host.docker.internal',
        addHostGateway: true,
        localDind: true,
        pooling: true,
      })
    this.image = options.image
    this.sharedSecret = options.sharedSecret ?? randomBytes(24).toString('hex')
    this.network = options.network
    this.extraEnv = options.env ?? {}
    this.exec = options.exec ?? defaultExec(this.adapter.binary)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  async start(ref: PreviewRef, spec: Record<string, unknown>, servePort: number): Promise<void> {
    const runId = previewRunId(ref.frameId)
    // Fresh container each start (a re-start replaces any prior preview for the frame).
    await this.adapter.removeRun(this.exec, runId)
    // On a localhost-publishing runtime (Docker family) PIN the host port to the serve port so
    // the browsable origin is `http://localhost:<servePort>` — deterministic and knowable ahead
    // of provision, matching the CORS origin a deployer injects (`frontendOriginsForService`).
    // Apple ignores publishPorts (reached by container IP), so the pin is a harmless no-op there.
    const pinsHostPort = this.adapter.publishesToLocalhost
    let containerId: string
    try {
      containerId = await this.adapter.run(this.exec, {
        runId,
        image: this.image,
        sharedSecret: this.sharedSecret,
        // A preview only builds + serves a static app (no Docker-in-Docker), so never privileged.
        privileged: false,
        network: this.network,
        env: this.extraEnv,
        publishPorts: [
          pinsHostPort ? { container: servePort, host: servePort } : { container: servePort },
        ],
      })
    } catch (err) {
      // Pinning the host port trades ephemeral-port collision-freedom for a deterministic origin,
      // so a serve port already bound on the host (another preview, or a local dev server —
      // 4173 is `vite preview`'s default) now fails the `-p` bind. Turn the raw daemon stderr
      // into an actionable message naming the port; only reachable on the pinned path.
      if (pinsHostPort && isHostPortInUseError(err)) {
        throw new Error(
          `The browsable preview can't start: host port ${servePort} is already in use. ` +
            `Free it (stop another running preview or a local dev server listening on :${servePort}) and try again.`,
        )
      }
      throw err
    }
    const endpoint = await this.waitForEndpoint(containerId)
    await this.waitForHealth(endpoint, containerId)
    this.cache.set(ref.frameId, { containerId, servePort })
    // Dispatch the single build+serve job to the harness (its `mode: 'preview'` keeps the serve
    // processes running past the job's completion).
    await postHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint,
      secret: this.sharedSecret,
      body: { ...spec, kind: 'agent' },
      timeoutMs: this.requestTimeoutMs,
      label: 'Preview',
    })
  }

  async poll(ref: PreviewRef): Promise<PreviewView> {
    const entry = this.cache.get(ref.frameId)
    const containerId =
      entry?.containerId ?? (await this.adapter.find(this.exec, previewRunId(ref.frameId)))
    // No container at all → it was reaped/never started.
    if (!containerId) return { state: 'failed', error: EVICTION_ERROR }

    const endpoint = await this.adapter.endpoint(this.exec, containerId)
    // Container present but its harness port isn't mapped yet — still coming up.
    if (!endpoint) return { state: 'starting' }

    const view = await pollHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint,
      jobId: PREVIEW_HARNESS_JOB_ID,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Preview',
      isDead: async () => {
        if (await this.adapter.isRunning(this.exec, containerId)) return false
        this.cache.delete(ref.frameId)
        return true
      },
    })

    if (view.state === 'failed') {
      return {
        state: 'failed',
        ...(view.error ? { error: view.error } : {}),
        ...(view.failureCause ? { failureCause: view.failureCause } : {}),
      }
    }
    if (view.state === 'done') {
      // The build finished and the app is served — form the browsable HOST URL from the serve
      // port. Without a known serve port (a poll after a process restart) we report `starting`
      // rather than a wrong URL; the service persists the URL on the first hit.
      const servePort = entry?.servePort
      if (servePort === undefined) return { state: 'starting' }
      // A localhost-publishing runtime pinned the host port to the serve port, so the origin is
      // deterministic — no `docker port` readback (which would report `127.0.0.1`, a DIFFERENT
      // origin from the injected `localhost` CORS entry). Apple has no published port, so read the
      // container's own IP and reach the serve port there.
      if (this.adapter.publishesToLocalhost) {
        return { state: 'running', url: `http://localhost:${servePort}` }
      }
      const serveEndpoint = await this.adapter.endpoint(this.exec, containerId, servePort)
      if (!serveEndpoint) return { state: 'starting' }
      return { state: 'running', url: harnessUrl(serveEndpoint, '') }
    }
    // Still building (the harness job is running).
    return { state: 'starting' }
  }

  async stop(ref: PreviewRef): Promise<void> {
    this.cache.delete(ref.frameId)
    // Remove by the run-id label so a container survives even if the in-memory cache was lost.
    await this.adapter.removeRun(this.exec, previewRunId(ref.frameId))
  }

  /** Wait for the harness `:8080` to be reachable (the published host port to appear). */
  private async waitForEndpoint(containerId: string): Promise<HarnessEndpoint> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const endpoint = await this.adapter.endpoint(this.exec, containerId)
      if (endpoint) return endpoint
      if (!(await this.adapter.isRunning(this.exec, containerId))) {
        throw new Error(await this.spinUpError(containerId, 'exited before its port was published'))
      }
      if (Date.now() >= deadline) {
        throw new Error(await this.spinUpError(containerId, 'never published its harness port'))
      }
      await delay(300)
    }
  }

  private waitForHealth(endpoint: ContainerEndpoint, containerId: string): Promise<void> {
    return waitForHarnessHealth({
      fetchImpl: this.fetchImpl,
      endpoint,
      readyTimeoutMs: this.readyTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      probeFirst: true,
      isDead: async () => !(await this.adapter.isRunning(this.exec, containerId)),
      deadError: () => this.spinUpError(containerId, 'exited before becoming healthy'),
      timeoutError: () => this.spinUpError(containerId, 'did not become healthy in time'),
    })
  }

  /** A spin-up error folding in a tail of the container logs (composed lazily on failure). */
  private async spinUpError(containerId: string, what: string): Promise<string> {
    const parts = [`Preview container ${containerId} ${what}.`]
    const logs = (await this.adapter.logs(this.exec, containerId)).trim()
    if (logs) parts.push(`Container logs:\n${logs}`)
    return parts.join('\n')
  }
}

/**
 * Build a {@link LocalPreviewTransport} from the process environment — the image (an explicit
 * `LOCAL_HARNESS_IMAGE`, else the backend-matched pin) + the runtime adapter selected by
 * `LOCAL_CONTAINER_RUNTIME`, sharing the same shared-secret / network / allowed-hosts wiring the
 * runner transport uses. `settings` is accepted for symmetry but a preview needs none of the
 * pool/checkout knobs.
 */
export function createLocalPreviewTransportFromEnv(
  env: NodeJS.ProcessEnv,
  _settings?: LocalSettings,
): LocalPreviewTransport {
  const extraEnv: Record<string, string> = {}
  const allowedHosts = harnessAllowedHosts(env)
  if (allowedHosts) extraEnv.GITHUB_ALLOWED_HOSTS = allowedHosts
  return new LocalPreviewTransport({
    image: resolveHarnessImage(env),
    adapter: createRuntimeAdapter(env),
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    network: env.LOCAL_DOCKER_NETWORK?.trim() || undefined,
    ...(Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {}),
  })
}
