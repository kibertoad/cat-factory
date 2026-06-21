import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { resolveDockerResources } from '@cat-factory/contracts'

const execFileAsync = promisify(execFile)

// The local-mode runner backend: each repo-operating agent job runs as its OWN
// local Docker/Podman container — the SAME executor-harness image the Cloudflare
// Worker runs per-run Containers from. It is the local analogue of
// `CloudflareContainerTransport` (a per-run Cloudflare Container) and of
// `RunnerPoolTransport` (an org's self-hosted pool): the ContainerAgentExecutor
// drives all three identically through the `RunnerTransport` port, addressed purely
// by the cat-factory job id.
//
// A container is started per job (`docker run -d`, harness `:8080` published to an
// ephemeral host port), labelled with the job id so a replayed dispatch re-attaches
// instead of starting a duplicate (the harness's own job registry is likewise
// idempotent per id). The harness reaches this service's LLM proxy at
// `host.docker.internal` — published via `--add-host` on Linux — and clones/pushes
// to github.com directly with the per-job token in the request body. Nothing
// long-lived is mounted: the per-job GitHub + proxy tokens travel in the POST body
// and live only for the job, in the container's ephemeral filesystem.

/** Maps a dispatch kind to the harness HTTP route that starts that job. */
const KIND_ROUTE: Record<RunnerDispatchKind, string> = {
  run: '/run',
  blueprint: '/blueprint',
  spec: '/spec',
  explore: '/explore',
  bootstrap: '/bootstrap',
  'ci-fix': '/ci-fix',
  'resolve-conflicts': '/resolve-conflicts',
  merge: '/merge',
  test: '/test',
  'fix-tests': '/fix-tests',
}

// The failed-poll error the engine classifies as a container eviction (matched by
// orchestration `isContainerEvictionError`, also used by the bootstrap flow). A
// vanished/exited local container maps to it so the run stops and the stale-run
// sweeper can re-drive it — mirroring the Worker transport's 404 mapping.
const EVICTION_ERROR = 'Job not found (container evicted or crashed)'

const LABEL_JOB = 'cat-factory.jobId'
const LABEL_MANAGED = 'cat-factory.managed=local-docker'
/** The port the harness listens on inside the container. */
const HARNESS_PORT = 8080
const SECRET_HEADER = 'x-harness-secret'

/** Injectable docker/podman CLI runner — overridable in tests. */
export type DockerExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

export interface LocalDockerRunnerTransportOptions {
  /** The executor-harness image ref (a GHCR pull or a locally built tag). */
  image: string
  /** The container CLI binary. Default `docker` (Podman works via the same surface). */
  binary?: string
  /**
   * Shared secret injected as `HARNESS_SHARED_SECRET` and sent as the
   * `x-harness-secret` header on every call. Defaults to a random per-process value.
   */
  sharedSecret?: string
  /**
   * Add `--add-host=host.docker.internal:host-gateway` so the harness can reach the
   * backend LLM proxy at `host.docker.internal` (needed on Linux; harmless on
   * Docker Desktop). Default true.
   */
  addHostGateway?: boolean
  /** Optional `--network` for the container. */
  network?: string
  /** Extra `-e KEY=VALUE` env passed into the container (rarely needed). */
  env?: Record<string, string>
  /** Injectable docker exec — defaults to running {@link binary} via execFile. */
  exec?: DockerExec
  /** Injectable fetch — defaults to the global. */
  fetchImpl?: typeof fetch
  /** How long to wait for the container's port + `/health` after start. Default 60s. */
  readyTimeoutMs?: number
  /** Per-HTTP-call timeout. Default 30s. */
  requestTimeoutMs?: number
  /**
   * Run the Tester (`test`) job container with `--privileged` so its in-container
   * Docker-in-Docker daemon can start and the Tester can `docker compose up` the
   * service's local infra. This is the local analogue of the Cloudflare harness's
   * rootless-dockerd path, but reliable: on a developer machine privileged DinD
   * "just works", keeping the service's dependencies on the job container's own
   * `localhost` (exactly what the Tester prompt assumes). Default true; set false to
   * fall back to the harness's best-effort rootless daemon (e.g. under Podman, whose
   * rootless containers can run nested Podman without `--privileged`). Only the
   * `test` kind gets it — every other kind runs unprivileged. See entrypoint.sh.
   */
  privilegedTestJobs?: boolean
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class LocalDockerRunnerTransport implements RunnerTransport {
  private readonly image: string
  private readonly binary: string
  private readonly sharedSecret: string
  private readonly addHostGateway: boolean
  private readonly network?: string
  private readonly extraEnv: Record<string, string>
  private readonly exec: DockerExec
  private readonly fetchImpl: typeof fetch
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly privilegedTestJobs: boolean

  /** jobId → resolved container handle, to spare a `docker` lookup on the hot poll path. */
  private readonly cache = new Map<string, { containerId: string; port: number }>()

  constructor(options: LocalDockerRunnerTransportOptions) {
    this.image = options.image
    this.binary = options.binary ?? 'docker'
    this.sharedSecret = options.sharedSecret ?? randomBytes(24).toString('hex')
    this.addHostGateway = options.addHostGateway ?? true
    this.network = options.network
    this.extraEnv = options.env ?? {}
    this.exec =
      options.exec ?? ((args) => execFileAsync(this.binary, args, { maxBuffer: 16 * 1024 * 1024 }))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.privilegedTestJobs = options.privilegedTestJobs ?? true
  }

  async dispatch(
    jobId: string,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'run',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    let resolved = await this.resolve(jobId)
    if (!resolved) {
      // A prior attempt may have left an exited/dead container under this job label
      // (resolve() returns undefined for one whose port is no longer published). Remove
      // any such container first so it can't shadow the fresh one in later label lookups
      // (findContainer returns the first match).
      await this.removeContainersForJob(jobId)
      const args = [
        'run',
        '-d',
        '--label',
        `${LABEL_JOB}=${jobId}`,
        '--label',
        LABEL_MANAGED,
        '-p',
        `127.0.0.1:0:${HARNESS_PORT}`,
        '-e',
        `HARNESS_SHARED_SECRET=${this.sharedSecret}`,
      ]
      // Size the per-job container on the host daemon from the service's abstract
      // instance size — the local backend never touches a cloud, it just provisions a
      // bigger/smaller Docker container (`--memory`/`--cpus`).
      if (options?.instanceSize) {
        const { memory, cpus } = resolveDockerResources(options.instanceSize)
        args.push('--memory', memory, '--cpus', cpus)
      }
      // The Tester stands its infra up with `docker compose` INSIDE the job container
      // (Docker-in-Docker), so the dependencies sit on the container's own localhost.
      // Run that one kind privileged so the in-container daemon can start. No other
      // kind needs Docker, so none other gets elevated.
      if (kind === 'test' && this.privilegedTestJobs) args.push('--privileged')
      if (this.addHostGateway) args.push('--add-host=host.docker.internal:host-gateway')
      if (this.network) args.push('--network', this.network)
      for (const [k, v] of Object.entries(this.extraEnv)) args.push('-e', `${k}=${v}`)
      args.push(this.image)

      const { stdout } = await this.exec(args)
      const containerId = stdout.trim().split(/\s+/).pop()
      if (!containerId) throw new Error('docker run returned no container id')
      const port = await this.waitForPort(containerId)
      resolved = { containerId, port }
      this.cache.set(jobId, resolved)
      await this.waitForHealth(resolved.port)
    }

    // POST the job to the kind's route. Idempotent: re-attaching to an already-running
    // container re-POSTs, which the harness's per-id registry treats as a re-attach.
    const res = await this.fetchImpl(this.url(resolved.port, KIND_ROUTE[kind]), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: this.sharedSecret },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!res.ok) {
      throw new Error(
        `Local container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }

  async poll(jobId: string): Promise<RunnerJobView> {
    const resolved = await this.resolve(jobId)
    // No container for this id at all → it was evicted/reaped (or never started).
    if (!resolved) return { state: 'failed', error: EVICTION_ERROR }

    let res: Response
    try {
      res = await this.fetchImpl(this.url(resolved.port, `/jobs/${encodeURIComponent(jobId)}`), {
        method: 'GET',
        headers: { [SECRET_HEADER]: this.sharedSecret },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (err) {
      // Connection refused / DNS gone: the container most likely exited. Confirm via
      // the daemon — if it is no longer running, report an eviction so the run stops;
      // otherwise surface the transient error so the caller can retry.
      if (!(await this.isRunning(resolved.containerId))) {
        this.cache.delete(jobId)
        return { state: 'failed', error: EVICTION_ERROR }
      }
      throw err
    }
    // The container is up but the harness no longer knows this job id (it was reaped
    // after completion, or the container was recreated): treat as an eviction.
    if (res.status === 404) return { state: 'failed', error: EVICTION_ERROR }
    if (!res.ok) {
      throw new Error(
        `Local container job poll failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
    return (await res.json()) as RunnerJobView
  }

  /**
   * Reclaim the per-job container now (`docker rm -f`) rather than leaving it idle.
   * Best-effort and idempotent: removing an already-gone container is a no-op.
   */
  async release(jobId: string): Promise<void> {
    const containerId = this.cache.get(jobId)?.containerId ?? (await this.findContainer(jobId))
    this.cache.delete(jobId)
    if (!containerId) return
    await this.exec(['rm', '-f', containerId]).catch(() => undefined)
  }

  /**
   * Reap exited per-job containers this transport manages — orphans a crash or hard
   * kill left behind (release() never ran for them). Best-effort; returns the count
   * removed. Call once at boot, before any job is in flight.
   */
  async reapExited(): Promise<number> {
    const { stdout } = await this.exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_MANAGED}`,
      '--filter',
      'status=exited',
    ])
    const ids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) await this.exec(['rm', '-f', ...ids]).catch(() => undefined)
    return ids.length
  }

  // --- internals ----------------------------------------------------------

  /** Force-remove every (running or exited) container labelled with this job id. */
  private async removeContainersForJob(jobId: string): Promise<void> {
    const { stdout } = await this.exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_JOB}=${jobId}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
    ])
    const ids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) await this.exec(['rm', '-f', ...ids]).catch(() => undefined)
  }

  private url(port: number, path: string): string {
    return `http://127.0.0.1:${port}${path}`
  }

  /** The container handle for a job from the cache, else rediscovered by label. */
  private async resolve(jobId: string): Promise<{ containerId: string; port: number } | undefined> {
    const cached = this.cache.get(jobId)
    if (cached) return cached
    const containerId = await this.findContainer(jobId)
    if (!containerId) return undefined
    const port = await this.hostPort(containerId)
    if (port === undefined) return undefined
    const resolved = { containerId, port }
    this.cache.set(jobId, resolved)
    return resolved
  }

  /** The (running-or-exited) container id labelled with this job id, if any. */
  private async findContainer(jobId: string): Promise<string | undefined> {
    const { stdout } = await this.exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_JOB}=${jobId}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
    ])
    return stdout.trim().split('\n')[0]?.trim() || undefined
  }

  /** Parse the published host port for the harness port, or undefined if unmapped. */
  private async hostPort(containerId: string): Promise<number | undefined> {
    const { stdout } = await this.exec(['port', containerId, `${HARNESS_PORT}/tcp`])
    // e.g. "127.0.0.1:49153" (possibly several lines for IPv4/IPv6); take the last
    // numeric segment of the first line.
    const line = stdout.trim().split('\n')[0]?.trim()
    if (!line) return undefined
    const port = Number(line.slice(line.lastIndexOf(':') + 1))
    return Number.isFinite(port) && port > 0 ? port : undefined
  }

  private async waitForPort(containerId: string): Promise<number> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const port = await this.hostPort(containerId).catch(() => undefined)
      if (port !== undefined) return port
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for container ${containerId} to publish its port`)
      }
      await delay(250)
    }
  }

  private async waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
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
        throw new Error(`Timed out waiting for the harness on :${port} to become healthy`)
      }
      await delay(300)
    }
  }

  private async isRunning(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await this.exec(['inspect', '-f', '{{.State.Running}}', containerId])
      return stdout.trim() === 'true'
    } catch {
      // No such container → not running.
      return false
    }
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
 * Build a {@link LocalDockerRunnerTransport} from the process environment. The image
 * ref (`LOCAL_HARNESS_IMAGE`) is required; everything else has sane local defaults.
 */
export function createLocalDockerTransportFromEnv(
  env: NodeJS.ProcessEnv,
): LocalDockerRunnerTransport {
  const image = env.LOCAL_HARNESS_IMAGE?.trim()
  if (!image) {
    throw new Error(
      'LOCAL_HARNESS_IMAGE is required for local mode: set it to the executor-harness image ref ' +
        '(a GHCR pull or a tag built from backend/internal/executor-harness/Dockerfile).',
    )
  }
  return new LocalDockerRunnerTransport({
    image,
    binary: env.LOCAL_DOCKER_BINARY?.trim() || 'docker',
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    network: env.LOCAL_DOCKER_NETWORK?.trim() || undefined,
    addHostGateway: env.LOCAL_DOCKER_ADD_HOST_GATEWAY?.trim() !== 'false',
    // Default on: the Tester stands its docker-compose infra up via Docker-in-Docker,
    // which needs a privileged job container. Set to `false` for runtimes that run
    // nested containers without it (e.g. rootless Podman).
    privilegedTestJobs: env.LOCAL_DOCKER_PRIVILEGED_TEST_JOBS?.trim() !== 'false',
  })
}
