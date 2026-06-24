import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { resolveDockerResources } from '@cat-factory/contracts'
import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerRuntimeAdapter,
  createRuntimeAdapter,
  DockerRuntimeAdapter,
} from './runtimes/index.js'

const execFileAsync = promisify(execFile)

// The local-mode runner backend: each RUN gets its OWN local container — the SAME
// executor-harness image the Cloudflare Worker runs per-run Containers from — which
// hosts that run's whole sequence of step jobs. It is the local analogue of
// `CloudflareContainerTransport` (a per-run Cloudflare Container) and of
// `RunnerPoolTransport` (an org's self-hosted pool): the ContainerAgentExecutor drives
// all three identically through the `RunnerTransport` port, addressed by a
// {@link RunnerJobRef} — the run id (which container) plus the per-step job id.
//
// HOW it talks to the runtime is delegated to a {@link ContainerRuntimeAdapter}, so this
// transport supports Docker, Podman, OrbStack, Colima (the Docker-CLI adapter) and
// Apple's `container` (its own adapter, VM-per-container, connect-by-IP) without forking.
// This class owns only the runtime-agnostic lifecycle: start a container per RUN, cache
// its endpoint, re-attach the run's later steps to it, poll the harness over HTTP, and
// reap it. The harness reaches this service's LLM proxy at the runtime's host alias and
// clones/pushes to github.com directly with the per-job token in the request body.

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
  'on-call': '/on-call',
  test: '/test',
  'fix-tests': '/fix-tests',
}

// The failed-poll error the engine classifies as a container eviction (matched by
// orchestration `isContainerEvictionError`, also used by the bootstrap flow). A
// vanished/exited local container maps to it so the run stops and the stale-run
// sweeper can re-drive it — mirroring the Worker transport's 404 mapping.
const EVICTION_ERROR = 'Job not found (container evicted or crashed)'

const SECRET_HEADER = 'x-harness-secret'

/** Injectable CLI runner — overridable in tests. Re-exported for callers/tests. */
export type { ContainerExec } from './runtimes/index.js'

export interface LocalContainerRunnerTransportOptions {
  /** The executor-harness image ref (a GHCR pull or a locally built tag). */
  image: string
  /**
   * The container runtime adapter (Docker-family or Apple). Defaults to the Docker-CLI
   * adapter (`docker` binary) so existing callers/tests keep working.
   */
  adapter?: ContainerRuntimeAdapter
  /**
   * Shared secret injected as `HARNESS_SHARED_SECRET` and sent as the
   * `x-harness-secret` header on every call. Defaults to a random per-process value.
   */
  sharedSecret?: string
  /** Optional `--network` for the container (docker family only). */
  network?: string
  /** Extra `-e KEY=VALUE` env passed into the container (rarely needed). */
  env?: Record<string, string>
  /** Injectable CLI exec — defaults to running the adapter's binary via execFile. */
  exec?: ContainerExec
  /** Injectable fetch — defaults to the global. */
  fetchImpl?: typeof fetch
  /** How long to wait for the container's endpoint + `/health` after start. Default 60s. */
  readyTimeoutMs?: number
  /** Per-HTTP-call timeout. Default 30s. */
  requestTimeoutMs?: number
  /**
   * Run the Tester (`test`) job container privileged so its in-container
   * Docker-in-Docker daemon can start and the Tester can `docker compose up` the
   * service's local infra. Only honoured by a runtime that supports DinD (the Apple
   * adapter ignores it — it has no nested-container path; the engine refuses local-infra
   * Tester runs there). Default true; set false to fall back to the harness's
   * best-effort rootless daemon (e.g. under rootless Podman).
   */
  privilegedTestJobs?: boolean
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class LocalContainerRunnerTransport implements RunnerTransport {
  private readonly adapter: ContainerRuntimeAdapter
  private readonly image: string
  private readonly sharedSecret: string
  private readonly network?: string
  private readonly extraEnv: Record<string, string>
  private readonly exec: ContainerExec
  private readonly fetchImpl: typeof fetch
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly privilegedTestJobs: boolean

  /** runId → resolved container handle, to spare a CLI lookup on the hot poll path. */
  private readonly cache = new Map<string, { containerId: string } & ContainerEndpoint>()

  constructor(options: LocalContainerRunnerTransportOptions) {
    this.adapter =
      options.adapter ??
      new DockerRuntimeAdapter({
        id: 'docker',
        binary: 'docker',
        hostAlias: 'host.docker.internal',
        addHostGateway: true,
        localDind: true,
      })
    this.image = options.image
    this.sharedSecret = options.sharedSecret ?? randomBytes(24).toString('hex')
    this.network = options.network
    this.extraEnv = options.env ?? {}
    this.exec =
      options.exec ??
      ((args) => execFileAsync(this.adapter.binary, args, { maxBuffer: 16 * 1024 * 1024 }))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.privilegedTestJobs = options.privilegedTestJobs ?? true
  }

  /** The runtime's capabilities (e.g. whether local Docker-in-Docker testing is possible). */
  get capabilities() {
    return this.adapter.capabilities
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'run',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    // The container is per-RUN: a run's first step starts it, later steps re-attach to
    // it (resolved by the run id), and the harness keys each step's job by the per-step
    // `ref.jobId` carried in the spec body.
    const runId = ref.runId
    let resolved = await this.resolve(runId)
    if (!resolved) {
      // A prior attempt may have left an exited/dead container under this run (resolve()
      // returns undefined for one whose endpoint is gone). Remove any such container
      // first so it can't shadow the fresh one in later lookups.
      await this.adapter.removeRun(this.exec, runId)
      const containerId = await this.adapter.run(this.exec, {
        runId,
        image: this.image,
        sharedSecret: this.sharedSecret,
        // The Tester stands its infra up with `docker compose` INSIDE the job container
        // (Docker-in-Docker), so run that one kind privileged. Runtimes without DinD
        // ignore it (and the engine never asks them to run local-infra Tester jobs).
        privileged: kind === 'test' && this.privilegedTestJobs,
        network: this.network,
        env: this.extraEnv,
        instanceSize: options?.instanceSize
          ? resolveDockerResources(options.instanceSize)
          : undefined,
      })
      const endpoint = await this.waitForEndpoint(containerId)
      resolved = { containerId, ...endpoint }
      this.cache.set(runId, resolved)
      await this.waitForHealth(endpoint)
    }

    // POST the job to the kind's route. Idempotent: re-attaching to an already-running
    // container re-POSTs, which the harness's per-id registry treats as a re-attach.
    const res = await this.fetchImpl(this.url(resolved, KIND_ROUTE[kind]), {
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

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    const resolved = await this.resolve(ref.runId)
    // No container for this run at all → it was evicted/reaped (or never started).
    if (!resolved) return { state: 'failed', error: EVICTION_ERROR }

    let res: Response
    try {
      // Address the per-RUN container, but read the per-step job by its own id.
      res = await this.fetchImpl(this.url(resolved, `/jobs/${encodeURIComponent(ref.jobId)}`), {
        method: 'GET',
        headers: { [SECRET_HEADER]: this.sharedSecret },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (err) {
      // Connection refused / DNS gone: the container most likely exited. Confirm via
      // the runtime — if it is no longer running, report an eviction so the run stops;
      // otherwise surface the transient error so the caller can retry.
      if (!(await this.adapter.isRunning(this.exec, resolved.containerId))) {
        this.cache.delete(ref.runId)
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
   * Reclaim the per-RUN container now rather than leaving it idle — this tears down the
   * whole run's container (and with it any step still running in it). Best-effort and
   * idempotent: removing an already-gone container is a no-op.
   */
  async release(ref: RunnerJobRef): Promise<void> {
    const containerId =
      this.cache.get(ref.runId)?.containerId ?? (await this.adapter.find(this.exec, ref.runId))
    this.cache.delete(ref.runId)
    if (!containerId) return
    await this.adapter.remove(this.exec, containerId)
  }

  /**
   * Reap exited per-run containers this transport manages — orphans a crash or hard
   * kill left behind (release() never ran for them). Best-effort; returns the count
   * removed. Call once at boot, before any job is in flight.
   */
  async reapExited(): Promise<number> {
    return this.adapter.reapExited(this.exec)
  }

  // --- internals ----------------------------------------------------------

  private url(endpoint: ContainerEndpoint, path: string): string {
    return `http://${endpoint.host}:${endpoint.port}${path}`
  }

  /** The container handle for a run from the cache, else rediscovered via the runtime. */
  private async resolve(
    runId: string,
  ): Promise<({ containerId: string } & ContainerEndpoint) | undefined> {
    const cached = this.cache.get(runId)
    if (cached) return cached
    const containerId = await this.adapter.find(this.exec, runId)
    if (!containerId) return undefined
    const endpoint = await this.adapter.endpoint(this.exec, containerId)
    if (!endpoint) return undefined
    const resolved = { containerId, ...endpoint }
    this.cache.set(runId, resolved)
    return resolved
  }

  private async waitForEndpoint(containerId: string): Promise<ContainerEndpoint> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const endpoint = await this.adapter.endpoint(this.exec, containerId).catch(() => undefined)
      if (endpoint) return endpoint
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for container ${containerId} to expose its endpoint`)
      }
      await delay(250)
    }
  }

  private async waitForHealth(endpoint: ContainerEndpoint): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      try {
        const res = await this.fetchImpl(this.url(endpoint, '/health'), {
          method: 'GET',
          signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 5_000)),
        })
        if (res.ok) return
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the harness at ${endpoint.host}:${endpoint.port} to become healthy`,
        )
      }
      await delay(300)
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
 * Build a {@link LocalContainerRunnerTransport} from the process environment. The image
 * ref (`LOCAL_HARNESS_IMAGE`) is required; the runtime adapter is selected by
 * `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack | colima | apple); everything
 * else has sane local defaults.
 */
export function createLocalContainerTransportFromEnv(
  env: NodeJS.ProcessEnv,
): LocalContainerRunnerTransport {
  const image = env.LOCAL_HARNESS_IMAGE?.trim()
  if (!image) {
    throw new Error(
      'LOCAL_HARNESS_IMAGE is required for local mode: set it to the executor-harness image ref ' +
        '(a GHCR pull or a tag built from backend/internal/executor-harness/Dockerfile).',
    )
  }
  return new LocalContainerRunnerTransport({
    image,
    adapter: createRuntimeAdapter(env),
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    network: env.LOCAL_DOCKER_NETWORK?.trim() || undefined,
    // Default on: the Tester stands its docker-compose infra up via Docker-in-Docker,
    // which needs a privileged job container. Set to `false` for runtimes that run
    // nested containers without it (e.g. rootless Podman).
    privilegedTestJobs: env.LOCAL_DOCKER_PRIVILEGED_TEST_JOBS?.trim() !== 'false',
  })
}
