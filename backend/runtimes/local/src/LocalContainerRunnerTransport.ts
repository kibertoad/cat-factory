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
//
// WARM POOL (opt-in, `LOCAL_POOL_SIZE>0` on a pooling-capable runtime): instead of cold
// -starting a container per run, idle harness containers are kept ready and LEASED to a
// run for its duration, then RETURNED to the pool. A leased member is preferentially one
// that already holds a checkout of the run's repo, so the harness does a `git fetch` +
// branch switch (persistent checkout) instead of a fresh clone — the run-spec carries
// `persistentCheckout: true` so the harness reuses its `/workspace/<owner>/<repo>` dir.
// Lease state lives IN THIS PROCESS (pool members aren't labelled by run id), so a run is
// addressed by the member it currently holds rather than a container label.

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
  /**
   * Warm-pool size: the max number of idle harness containers kept ready for re-lease.
   * `0` (default) disables pooling entirely — every run cold-starts its own container and
   * is torn down on release, the classic behaviour. Pooling additionally requires a
   * runtime whose `capabilities.pooling` is true (the Docker family); it is ignored on
   * Apple `container`.
   */
  poolSize?: number
  /** Members to pre-warm at boot (clamped to `poolMax`). Default 0. */
  poolMinWarm?: number
  /**
   * Hard cap on total members (leased + idle). A lease beyond this starts a TRANSIENT
   * member that is removed on release rather than returned to the pool. Default = poolSize.
   */
  poolMax?: number
  /** How long an idle pooled member is kept before eviction. Default 10 min. */
  poolIdleTtlMs?: number
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A warm-pool container the transport leases to runs (lease state is in-process). */
interface PoolMember extends ContainerEndpoint {
  /** Internal member id (used only for the container name; never a run-id label). */
  id: string
  containerId: string
  /** `owner/name` of the repo this member last checked out (affinity hint). */
  repo?: string
  /** The run id currently holding this member, or undefined when idle. */
  leasedTo?: string
  /** Over-capacity member: removed on release instead of returned to the pool. */
  transient: boolean
  /** Idle-eviction timer set while the member is unleased. */
  idleTimer?: ReturnType<typeof setTimeout>
}

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
  private readonly poolSize: number
  private readonly poolMax: number
  private readonly poolMinWarm: number
  private readonly poolIdleTtlMs: number

  /** runId → resolved container handle, to spare a CLI lookup on the hot poll path. */
  private readonly cache = new Map<string, { containerId: string } & ContainerEndpoint>()

  /** Warm-pool members (only used when pooling is enabled). Leased in-process by run id. */
  private readonly members: PoolMember[] = []

  /**
   * Members whose container start is in flight (started but not yet pushed to `members`).
   * Counted toward the cap so concurrent cold-starts can't all read a low `members.length`
   * and overshoot `poolMax`.
   */
  private pendingStarts = 0

  constructor(options: LocalContainerRunnerTransportOptions) {
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
    this.exec =
      options.exec ??
      ((args) => execFileAsync(this.adapter.binary, args, { maxBuffer: 16 * 1024 * 1024 }))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.privilegedTestJobs = options.privilegedTestJobs ?? true
    this.poolSize = Math.max(0, Math.floor(options.poolSize ?? 0))
    this.poolMax = Math.max(this.poolSize, Math.floor(options.poolMax ?? this.poolSize))
    this.poolMinWarm = Math.max(0, Math.min(Math.floor(options.poolMinWarm ?? 0), this.poolMax))
    this.poolIdleTtlMs = Math.max(0, Math.floor(options.poolIdleTtlMs ?? 600_000))
  }

  /** The runtime's capabilities (e.g. whether local Docker-in-Docker testing is possible). */
  get capabilities() {
    return this.adapter.capabilities
  }

  /** Whether the warm pool is active (a size is configured AND the runtime supports it). */
  private get poolingEnabled(): boolean {
    return this.poolSize > 0 && this.adapter.capabilities.pooling
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    if (this.poolingEnabled) return this.dispatchPooled(ref, spec, kind)

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
        // (Docker-in-Docker). The container is per-RUN and created by the run's FIRST step
        // (not the tester), so we can't gate privileged on the dispatch kind — instead the
        // whole run's container runs privileged whenever local DinD test jobs are enabled
        // (the default). Runtimes without DinD set `privilegedTestJobs` false, and the engine
        // refuses a local-infra Tester run there (the `localDind` capability gate).
        privileged: this.privilegedTestJobs,
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

    // POST the job to the single harness endpoint, with the kind in the body. Idempotent:
    // re-attaching to an already-running container re-POSTs, which the harness's per-id
    // registry treats as a re-attach.
    await this.postJob(resolved, { ...spec, kind })
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    if (this.poolingEnabled) return this.pollPooled(ref)

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
   * idempotent: removing an already-gone container is a no-op. With pooling enabled, this
   * RETURNS the leased member to the pool (or removes a transient/over-capacity one).
   */
  async release(ref: RunnerJobRef): Promise<void> {
    if (this.poolingEnabled) return this.releasePooled(ref)

    const containerId =
      this.cache.get(ref.runId)?.containerId ?? (await this.adapter.find(this.exec, ref.runId))
    this.cache.delete(ref.runId)
    if (!containerId) return
    await this.adapter.remove(this.exec, containerId)
  }

  /**
   * Reap exited per-run containers this transport manages — orphans a crash or hard
   * kill left behind (release() never ran for them). Best-effort; returns the count
   * removed. Call once at boot, before any job is in flight. When pooling is enabled it
   * ALSO drains pool members orphaned by a previous process (their in-process lease state
   * died with it, so they can't be safely re-leased) and pre-warms the configured minimum.
   */
  async reapExited(): Promise<number> {
    const reaped = await this.adapter.reapExited(this.exec)
    if (this.poolingEnabled) {
      await this.drainPoolOrphans()
      await this.prewarmPool()
    }
    return reaped
  }

  // --- warm pool ----------------------------------------------------------

  private async dispatchPooled(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
  ): Promise<void> {
    const repoKey = repoKeyOf(spec)
    // Later steps of the same run re-attach to the member it already holds (idempotent).
    let member = this.members.find((m) => m.leasedTo === ref.runId)
    if (!member) member = await this.acquireMember(ref.runId, repoKey)
    if (repoKey) member.repo = repoKey
    // Tell the harness to reuse its per-repo checkout (clean-sweep + fetch + switch branch)
    // rather than clone fresh — the whole point of repo-affinity pooling.
    await this.postJob(member, { ...spec, kind, persistentCheckout: true })
  }

  private async pollPooled(ref: RunnerJobRef): Promise<RunnerJobView> {
    const member = this.members.find((m) => m.leasedTo === ref.runId)
    if (!member) return { state: 'failed', error: EVICTION_ERROR }
    let res: Response
    try {
      res = await this.fetchImpl(this.url(member, `/jobs/${encodeURIComponent(ref.jobId)}`), {
        method: 'GET',
        headers: { [SECRET_HEADER]: this.sharedSecret },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (err) {
      // The member died mid-run: drop it from the pool so it isn't re-leased, and report
      // an eviction so the stale-run sweeper re-drives (a retry leases a healthy member
      // and the harness's persistent checkout resumes the work branch).
      if (!(await this.adapter.isRunning(this.exec, member.containerId))) {
        this.dropMember(member)
        return { state: 'failed', error: EVICTION_ERROR }
      }
      throw err
    }
    // Member is up but the harness lost this job id (reaped after completion / recreated):
    // an eviction, but the member itself is healthy so keep it leased for a re-dispatch.
    if (res.status === 404) return { state: 'failed', error: EVICTION_ERROR }
    if (!res.ok) {
      throw new Error(
        `Local container job poll failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
    return (await res.json()) as RunnerJobView
  }

  private async releasePooled(ref: RunnerJobRef): Promise<void> {
    const member = this.members.find((m) => m.leasedTo === ref.runId)
    if (!member) return
    member.leasedTo = undefined
    // An over-capacity (transient) member is torn down; a pooled one returns to the warm
    // set with an idle-eviction timer, and we trim any idle excess beyond `poolSize`.
    if (member.transient) {
      this.dropMember(member)
      await this.adapter.remove(this.exec, member.containerId)
      return
    }
    this.scheduleIdleEviction(member)
    await this.trimIdle()
  }

  /** Lease a member for `runId`, preferring repo affinity, starting one if needed. */
  private async acquireMember(runId: string, repoKey: string | undefined): Promise<PoolMember> {
    // Prefer an idle member already holding this repo (fastest: fetch + switch branch),
    // then any idle member, replacing any that turns out to be unhealthy.
    for (;;) {
      const idle =
        (repoKey ? this.members.find((m) => !m.leasedTo && m.repo === repoKey) : undefined) ??
        this.members.find((m) => !m.leasedTo)
      if (!idle) break
      // CLAIM the member synchronously, BEFORE the `await` below, so a concurrent
      // acquireMember can't `find` the same idle member and double-lease it (two runs
      // sharing one container + checkout). If it turns out unhealthy we release the claim.
      idle.leasedTo = runId
      this.clearIdleEviction(idle)
      if (await this.isHealthy(idle)) return idle
      // Unhealthy idle member → remove and try the next candidate.
      this.dropMember(idle)
      await this.adapter.remove(this.exec, idle.containerId)
    }
    // No idle member: start a new one. Within the cap it's a pooled member; beyond the cap
    // it's a transient member torn down on release (so a burst never blocks). Count in-flight
    // starts toward the cap so concurrent cold-starts can't all see a low count and overshoot.
    const transient = this.members.length + this.pendingStarts >= this.poolMax
    this.pendingStarts++
    let member: PoolMember
    try {
      member = await this.startMember(transient)
    } finally {
      this.pendingStarts--
    }
    member.leasedTo = runId
    return member
  }

  /** Start a fresh pool member container and wait for it to be healthy. */
  private async startMember(transient: boolean): Promise<PoolMember> {
    const id = `pool-${randomBytes(6).toString('hex')}`
    const containerId = await this.adapter.run(this.exec, {
      runId: id,
      image: this.image,
      sharedSecret: this.sharedSecret,
      // Pooled members are reused across runs (incl. Tester runs), so they run privileged
      // when the runtime supports DinD — the same rule as a per-run container. Per-run
      // instance sizing is NOT applied to a reused member (it keeps host defaults).
      privileged: this.privilegedTestJobs,
      network: this.network,
      env: this.extraEnv,
      pool: true,
    })
    const endpoint = await this.waitForEndpoint(containerId)
    await this.waitForHealth(endpoint)
    const member: PoolMember = { id, containerId, transient, ...endpoint }
    this.members.push(member)
    return member
  }

  /** Pre-warm idle members up to `poolMinWarm` (best-effort; a failure is logged-and-skipped). */
  private async prewarmPool(): Promise<void> {
    while (this.members.length < this.poolMinWarm) {
      try {
        const member = await this.startMember(false)
        this.scheduleIdleEviction(member)
      } catch {
        break
      }
    }
  }

  /**
   * Remove every pool member the runtime reports from a PREVIOUS process — their
   * in-process lease state died with that process, so they can't be safely re-leased.
   * Best-effort and idempotent.
   */
  private async drainPoolOrphans(): Promise<void> {
    const ids = await this.adapter.listPoolMembers(this.exec).catch(() => [])
    for (const containerId of ids) {
      await this.adapter.remove(this.exec, containerId).catch(() => undefined)
    }
  }

  /** Remove idle members beyond `poolSize` (oldest first) so the warm set stays bounded. */
  private async trimIdle(): Promise<void> {
    const idle = this.members.filter((m) => !m.leasedTo)
    let excess = idle.length - this.poolSize
    for (const member of idle) {
      if (excess <= 0) break
      this.dropMember(member)
      await this.adapter.remove(this.exec, member.containerId)
      excess--
    }
  }

  private scheduleIdleEviction(member: PoolMember): void {
    this.clearIdleEviction(member)
    if (this.poolIdleTtlMs <= 0) return
    member.idleTimer = setTimeout(() => {
      // Only evict if still idle when the timer fires.
      if (member.leasedTo) return
      this.dropMember(member)
      void this.adapter.remove(this.exec, member.containerId).catch(() => undefined)
    }, this.poolIdleTtlMs)
    member.idleTimer.unref?.()
  }

  private clearIdleEviction(member: PoolMember): void {
    if (member.idleTimer) {
      clearTimeout(member.idleTimer)
      member.idleTimer = undefined
    }
  }

  /** Drop a member from the in-process pool (does NOT remove the container). */
  private dropMember(member: PoolMember): void {
    this.clearIdleEviction(member)
    const i = this.members.indexOf(member)
    if (i !== -1) this.members.splice(i, 1)
  }

  /** A single quick `/health` probe (vs `waitForHealth`'s retry loop) for re-lease. */
  private async isHealthy(endpoint: ContainerEndpoint): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url(endpoint, '/health'), {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 5_000)),
      })
      return res.ok
    } catch {
      return false
    }
  }

  // --- internals ----------------------------------------------------------

  /** POST a job body to a container's harness, throwing on a non-OK response. */
  private async postJob(endpoint: ContainerEndpoint, body: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(this.url(endpoint, '/jobs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: this.sharedSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!res.ok) {
      throw new Error(
        `Local container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }

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

/** The `owner/name` repo-affinity key from a dispatched job spec, when present. */
function repoKeyOf(spec: Record<string, unknown>): string | undefined {
  const repo = spec.repo
  if (typeof repo !== 'object' || repo === null) return undefined
  const { owner, name } = repo as { owner?: unknown; name?: unknown }
  if (typeof owner !== 'string' || typeof name !== 'string' || !owner || !name) return undefined
  return `${owner}/${name}`
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
  const poolSize = numberEnv(env.LOCAL_POOL_SIZE)
  return new LocalContainerRunnerTransport({
    image,
    adapter: createRuntimeAdapter(env),
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    network: env.LOCAL_DOCKER_NETWORK?.trim() || undefined,
    // Default on: the Tester stands its docker-compose infra up via Docker-in-Docker,
    // which needs a privileged job container. Set to `false` for runtimes that run
    // nested containers without it (e.g. rootless Podman).
    privilegedTestJobs: env.LOCAL_DOCKER_PRIVILEGED_TEST_JOBS?.trim() !== 'false',
    // Warm pool (opt-in): keep idle harness containers ready and re-lease them with
    // repo-affinity checkout reuse. 0 (default) keeps the classic per-run behaviour.
    ...(poolSize !== undefined ? { poolSize } : {}),
    ...(numberEnv(env.LOCAL_POOL_MIN_WARM) !== undefined
      ? { poolMinWarm: numberEnv(env.LOCAL_POOL_MIN_WARM) }
      : {}),
    ...(numberEnv(env.LOCAL_POOL_MAX) !== undefined
      ? { poolMax: numberEnv(env.LOCAL_POOL_MAX) }
      : {}),
    ...(numberEnv(env.LOCAL_POOL_IDLE_TTL_MS) !== undefined
      ? { poolIdleTtlMs: numberEnv(env.LOCAL_POOL_IDLE_TTL_MS) }
      : {}),
  })
}

/** Parse a non-negative integer env var, or undefined when unset/blank/invalid. */
function numberEnv(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}
