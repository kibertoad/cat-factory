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
import type { LocalSettings } from '@cat-factory/contracts'
import {
  EVICTION_ERROR,
  type HarnessEndpoint,
  delay,
  harnessHealthy,
  pollHarnessJob,
  postHarnessJob,
} from './harnessHttp.js'
import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerRuntimeAdapter,
  createRuntimeAdapter,
  DockerRuntimeAdapter,
} from './runtimes/index.js'
import { harnessAllowedHosts } from './github.js'

const execFileAsync = promisify(execFile)

/**
 * The default {@link ContainerExec}: run the runtime binary via `execFile` and, on a
 * non-zero exit, rethrow an error whose message carries the binary, the sub-command, and
 * the captured `stderr`. `execFile`'s own rejection message is a terse "Command failed:
 * <cmd>" that drops the daemon's actual complaint ("Cannot connect to the Docker daemon",
 * "manifest unknown", "permission denied"), so without this the dispatch-failure detail
 * shown on the step would have no root cause.
 */
function defaultExec(binary: string): ContainerExec {
  return async (args) => {
    try {
      return await execFileAsync(binary, args, { maxBuffer: 16 * 1024 * 1024 })
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string }
      const reason = (e.stderr ?? '').trim() || (e.message ?? '').trim() || 'unknown error'
      throw new Error(`\`${binary} ${args[0] ?? ''}\` failed: ${reason}`)
    }
  }
}

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
// WARM POOL (opt-in, pool size > 0 — configured in the DB-backed local-mode settings — on a
// pooling-capable runtime): instead of cold
// -starting a container per run, idle harness containers are kept ready and LEASED to a
// run for its duration, then RETURNED to the pool. A leased member is preferentially one
// that already holds a checkout of the run's repo, so the harness does a `git fetch` +
// branch switch (persistent checkout) instead of a fresh clone — the run-spec carries
// `persistentCheckout: true` so the harness reuses its `/workspace/<owner>/<repo>` dir.
// Lease state lives IN THIS PROCESS (pool members aren't labelled by run id), so a run is
// addressed by the member it currently holds rather than a container label.

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
  // Mutable: the warm-pool sizing + checkout env are re-read live via `applySettings` when
  // the DB-backed local-mode settings change, so an edit takes effect without a restart.
  private extraEnv: Record<string, string>
  private readonly exec: ContainerExec
  private readonly fetchImpl: typeof fetch
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly privilegedTestJobs: boolean
  private poolSize: number
  private poolMax: number
  private poolMinWarm: number
  private poolIdleTtlMs: number

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
    this.exec = options.exec ?? defaultExec(this.adapter.binary)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.privilegedTestJobs = options.privilegedTestJobs ?? true
    this.poolSize = 0
    this.poolMax = 0
    this.poolMinWarm = 0
    this.poolIdleTtlMs = 600_000
    this.configurePool(options)
  }

  /**
   * Set the warm-pool sizing fields from (defaulting) options. Shared by the constructor
   * and {@link applySettings} so the clamps live in one place.
   */
  private configurePool(opts: {
    poolSize?: number
    poolMax?: number
    poolMinWarm?: number
    poolIdleTtlMs?: number
  }): void {
    this.poolSize = Math.max(0, Math.floor(opts.poolSize ?? 0))
    this.poolMax = Math.max(this.poolSize, Math.floor(opts.poolMax ?? this.poolSize))
    // Clamp the pre-warm count to `poolSize` (the max IDLE members kept), NOT `poolMax`:
    // `trimIdle` reaps idle members beyond `poolSize` on every release, so a minWarm above
    // poolSize would be pre-warmed at boot only to be torn down after the first run —
    // silently violating the warm floor. Keeping minWarm <= poolSize makes the floor hold.
    this.poolMinWarm = Math.max(0, Math.min(Math.floor(opts.poolMinWarm ?? 0), this.poolSize))
    this.poolIdleTtlMs = Math.max(0, Math.floor(opts.poolIdleTtlMs ?? 600_000))
  }

  /**
   * Re-read the DB-backed local-mode settings into the ALREADY-BUILT transport so an edit
   * in the settings panel takes effect WITHOUT a restart (the serving transport is built
   * once and cached). Warm-pool sizing is applied live — `trimIdle` reaps idle members
   * beyond the new `poolSize` and (when pooling is enabled) `prewarmPool` tops back up to
   * `minWarm`; the checkout env applies to containers STARTED after this call. In-flight
   * runs are never stranded: poll/release/dispatch route a run to the backend it ALREADY
   * holds (a leased member or a per-run container), independent of the current pool mode,
   * so even toggling pooling on/off mid-flight is safe.
   */
  applySettings(settings?: LocalSettings): void {
    this.configurePool({
      poolSize: settings?.pool?.size,
      poolMax: settings?.pool?.max ?? undefined,
      poolMinWarm: settings?.pool?.minWarm,
      poolIdleTtlMs: settings?.pool?.idleTtlMs,
    })
    this.extraEnv = checkoutExtraEnv(settings)
    void this.reconcilePool().catch(() => {})
  }

  /** Bring the warm set in line with the current sizing: trim excess idle, then re-warm. */
  private async reconcilePool(): Promise<void> {
    await this.trimIdle()
    if (this.poolingEnabled) await this.prewarmPool()
  }

  /** The runtime's capabilities (e.g. whether local Docker-in-Docker testing is possible). */
  get capabilities() {
    return this.adapter.capabilities
  }

  /** Whether the warm pool is active (a size is configured AND the runtime supports it). */
  private get poolingEnabled(): boolean {
    return this.poolSize > 0 && this.adapter.capabilities.pooling
  }

  /** Whether a pool member is currently leased to this run (in-process lease state). */
  private hasLeasedMember(runId: string): boolean {
    return this.members.some((m) => m.leasedTo === runId)
  }

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    // Route a run to the backend it ALREADY holds, regardless of the CURRENT pool mode
    // (settings can flip pooling on/off live): a leased pool member re-attaches to the
    // pool; an existing per-run container stays per-run. Only a BRAND-NEW run picks its
    // mode from `poolingEnabled` — so a live resize never strands an in-flight run.
    if (this.hasLeasedMember(ref.runId)) return this.dispatchPooled(ref, spec, kind)
    if (this.cache.has(ref.runId)) return this.dispatchPerRun(ref, spec, kind, options)
    if (this.poolingEnabled) return this.dispatchPooled(ref, spec, kind)
    return this.dispatchPerRun(ref, spec, kind, options)
  }

  private async dispatchPerRun(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
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
      await this.waitForHealth(endpoint, containerId)
    }

    // POST the job to the single harness endpoint, with the kind in the body. Idempotent:
    // re-attaching to an already-running container re-POSTs, which the harness's per-id
    // registry treats as a re-attach.
    await this.postJob(resolved, { ...spec, kind })
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    if (this.hasLeasedMember(ref.runId)) return this.pollPooled(ref)

    const resolved = await this.resolve(ref.runId)
    // No container for this run at all → it was evicted/reaped (or never started).
    if (!resolved) return { state: 'failed', error: EVICTION_ERROR }

    // Address the per-RUN container, but read the per-step job by its own id. A connection
    // error confirms-or-denies an eviction via the runtime; a confirmed-dead container
    // clears the cache so the next dispatch starts fresh.
    return pollHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: resolved,
      jobId: ref.jobId,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Local container',
      isDead: async () => {
        if (await this.adapter.isRunning(this.exec, resolved.containerId)) return false
        this.cache.delete(ref.runId)
        return true
      },
    })
  }

  /**
   * Reclaim the per-RUN container now rather than leaving it idle — this tears down the
   * whole run's container (and with it any step still running in it). Best-effort and
   * idempotent: removing an already-gone container is a no-op. A run that holds a pool
   * member instead RETURNS it to the pool (or removes a transient/over-capacity one).
   */
  async release(ref: RunnerJobRef): Promise<void> {
    if (this.hasLeasedMember(ref.runId)) return this.releasePooled(ref)

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

  /** POST a job body to a harness, throwing on a non-OK response. */
  private postJob(endpoint: HarnessEndpoint, body: Record<string, unknown>): Promise<void> {
    return postHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint,
      secret: this.sharedSecret,
      body,
      timeoutMs: this.requestTimeoutMs,
      label: 'Local container',
    })
  }

  private async pollPooled(ref: RunnerJobRef): Promise<RunnerJobView> {
    const member = this.members.find((m) => m.leasedTo === ref.runId)
    if (!member) return { state: 'failed', error: EVICTION_ERROR }
    // The member died mid-run: drop it from the pool so it isn't re-leased, and report an
    // eviction so the stale-run sweeper re-drives (a retry leases a healthy member and the
    // harness's persistent checkout resumes the work branch). A 404 with the member still
    // healthy keeps it leased for a re-dispatch (handled inside pollHarnessJob).
    return pollHarnessJob({
      fetchImpl: this.fetchImpl,
      endpoint: member,
      jobId: ref.jobId,
      secret: this.sharedSecret,
      timeoutMs: this.requestTimeoutMs,
      label: 'Local container',
      isDead: async () => {
        if (await this.adapter.isRunning(this.exec, member.containerId)) return false
        this.dropMember(member)
        return true
      },
    })
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
      if (await harnessHealthy(this.fetchImpl, idle, this.requestTimeoutMs)) return idle
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
    await this.waitForHealth(endpoint, containerId)
    const member: PoolMember = { id, containerId, transient, ...endpoint }
    this.members.push(member)
    return member
  }

  /**
   * Pre-warm IDLE members up to `poolMinWarm`. The deficit counts only currently-idle
   * members (plus in-flight starts), NOT leased ones: counting leased members would
   * under-warm the idle floor whenever this runs while runs are in flight (e.g. a live
   * `applySettings`/`reconcilePool` mid-run), leaving the next runs to cold-start. The
   * missing members are started CONCURRENTLY — one at a time would stack each container's
   * full boot+health latency, delaying pool readiness by ~deficit×. Best-effort: a member
   * that fails to start is skipped (the pool then fills the rest on demand).
   */
  private async prewarmPool(): Promise<void> {
    const idle = this.members.filter((m) => !m.leasedTo).length
    const deficit = this.poolMinWarm - idle - this.pendingStarts
    if (deficit <= 0) return
    await Promise.all(
      Array.from({ length: deficit }, async () => {
        try {
          this.scheduleIdleEviction(await this.startMember(false))
        } catch {
          // a failed pre-warm is logged-and-skipped; the pool fills on demand
        }
      }),
    )
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

  // --- internals ----------------------------------------------------------

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
    let lastError: unknown
    for (;;) {
      const endpoint = await this.adapter.endpoint(this.exec, containerId).catch((err) => {
        lastError = err
        return undefined
      })
      if (endpoint) return endpoint
      // Fail fast: a container that has already exited will never expose an endpoint, so
      // surface its boot logs now instead of stalling for the whole ready timeout.
      if (!(await this.adapter.isRunning(this.exec, containerId))) {
        throw new Error(
          await this.startupFailure(containerId, 'exited before exposing its endpoint', lastError),
        )
      }
      if (Date.now() >= deadline) {
        throw new Error(
          await this.startupFailure(
            containerId,
            'did not expose its endpoint before the start timeout',
            lastError,
          ),
        )
      }
      await delay(250)
    }
  }

  private async waitForHealth(endpoint: ContainerEndpoint, containerId: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      if (await harnessHealthy(this.fetchImpl, endpoint, this.requestTimeoutMs)) return
      // Not healthy YET. Fail fast only if the container has actually died — otherwise it is
      // still booting, so keep waiting until the deadline. (The old behaviour spun the whole
      // ready timeout against a dead container, then threw a generic, root-cause-less error.)
      if (!(await this.adapter.isRunning(this.exec, containerId))) {
        throw new Error(
          await this.startupFailure(containerId, 'exited before the harness became healthy'),
        )
      }
      if (Date.now() >= deadline) {
        throw new Error(
          await this.startupFailure(
            containerId,
            `harness at ${endpoint.host}:${endpoint.port} did not become healthy before the start timeout`,
          ),
        )
      }
      await delay(300)
    }
  }

  /**
   * Compose a fail-fast container-start error: the run's container id, what went wrong, the
   * last CLI/endpoint error seen, and a tail of the container's own logs (the boot crash).
   * Deliberately avoids the phrase `evicted or crashed` so the engine classifies it as a
   * `dispatch` failure ("the container failed to start"), not an eviction recovery.
   */
  private async startupFailure(
    containerId: string,
    what: string,
    lastError?: unknown,
  ): Promise<string> {
    const parts = [`Container ${containerId} ${what}.`]
    const reason =
      lastError instanceof Error ? lastError.message : lastError ? String(lastError) : ''
    if (reason.trim()) parts.push(`Last error: ${reason.trim()}`)
    const logs = (await this.adapter.logs(this.exec, containerId)).trim()
    if (logs) parts.push(`Container logs:\n${logs}`)
    return parts.join('\n')
  }
}

/**
 * The harness `-e` env carrying the per-repo checkout-reuse knobs (consumed INSIDE the
 * container). Absent fields ⇒ the harness uses its built-in defaults (/workspace, the
 * default keep set). Shared by the initial build and the live `applySettings` re-read.
 */
function checkoutExtraEnv(settings?: LocalSettings): Record<string, string> {
  const checkout = settings?.checkout
  const env: Record<string, string> = {}
  if (checkout?.workspaceRoot) env.HARNESS_WORKSPACE_ROOT = checkout.workspaceRoot
  if (checkout?.cleanKeep && checkout.cleanKeep.length > 0) {
    env.HARNESS_CLEAN_KEEP = checkout.cleanKeep.join(',')
  }
  return env
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
 * Build a {@link LocalContainerRunnerTransport} from the process environment plus the
 * DB-stored local-mode {@link LocalSettings} (warm-pool sizing + per-repo checkout reuse —
 * these REPLACED the old `LOCAL_POOL_*` / `HARNESS_*` env vars; edit them in the local-mode
 * settings panel). The image ref (`LOCAL_HARNESS_IMAGE`) is required; the runtime adapter is
 * selected by `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack | colima | apple).
 * `settings` omitted ⇒ pooling off + harness defaults (e.g. an early boot-reap call).
 */
export function createLocalContainerTransportFromEnv(
  env: NodeJS.ProcessEnv,
  settings?: LocalSettings,
): LocalContainerRunnerTransport {
  const image = env.LOCAL_HARNESS_IMAGE?.trim()
  if (!image) {
    throw new Error(
      'LOCAL_HARNESS_IMAGE is required for local mode: set it to the executor-harness image ref ' +
        '(a GHCR pull or a tag built from backend/internal/executor-harness/Dockerfile).',
    )
  }
  const pool = settings?.pool
  const extraEnv = checkoutExtraEnv(settings)
  // The harness validates every clone/push host against an allow-list defaulting to
  // github.com. A GitLab local deployment clones a GitLab host, so forward it (plus any
  // operator-set hosts) into the container — otherwise the harness rejects the GitLab clone
  // URL before it can clone. No-op for a GitHub deployment with no extra hosts.
  const allowedHosts = harnessAllowedHosts(env)
  if (allowedHosts) extraEnv.GITHUB_ALLOWED_HOSTS = allowedHosts
  return new LocalContainerRunnerTransport({
    image,
    adapter: createRuntimeAdapter(env),
    sharedSecret: env.HARNESS_SHARED_SECRET?.trim() || undefined,
    network: env.LOCAL_DOCKER_NETWORK?.trim() || undefined,
    // Default on: the Tester stands its docker-compose infra up via Docker-in-Docker,
    // which needs a privileged job container. Set to `false` for runtimes that run
    // nested containers without it (e.g. rootless Podman).
    privilegedTestJobs: env.LOCAL_DOCKER_PRIVILEGED_TEST_JOBS?.trim() !== 'false',
    ...(Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {}),
    // Warm pool (opt-in via the settings panel): keep idle harness containers ready and
    // re-lease them with repo-affinity checkout reuse. size 0 keeps the per-run behaviour.
    ...(pool
      ? {
          poolSize: pool.size,
          poolMinWarm: pool.minWarm,
          ...(pool.max != null ? { poolMax: pool.max } : {}),
          poolIdleTtlMs: pool.idleTtlMs,
        }
      : {}),
  })
}
