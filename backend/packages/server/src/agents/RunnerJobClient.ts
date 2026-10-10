import type {
  RunnerDispatchAck,
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerImageVariant,
  RunnerJobRef,
  RunnerJobStopOutcome,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'

/**
 * Resolve the runner backend a workspace's container jobs run on. Picks a
 * workspace's self-hosted runner pool when one is registered (and runner pools are
 * enabled), else the per-run Cloudflare Container. Called per dispatch and per poll;
 * a poll/release passes the job's `workspaceId` (carried on the job's handle) so it
 * resolves the same backend it dispatched to.
 */
export type ResolveRunnerTransport = (workspaceId: string | undefined) => Promise<RunnerTransport>

/**
 * The shared dispatch → poll → release plumbing every container-backed flow rides
 * (the implementation executor and the repo bootstrapper today; the scanner next).
 * Each flow keeps its own "mint tokens + build the harness body" and "map the
 * runner view into its result" — the parts that genuinely differ — and delegates
 * the backend-polymorphic transport mechanics here so they are written once.
 *
 * It is a thin wrapper over {@link ResolveRunnerTransport}: it resolves the right
 * backend (Cloudflare container vs. self-hosted pool) for the job's workspace on
 * every call, then dispatches/polls/releases through it. Stateless, so a caller may
 * construct one per flow and reuse it across jobs.
 */
export class RunnerJobClient {
  constructor(private readonly resolveTransport: ResolveRunnerTransport) {}

  /**
   * Start (or idempotently re-attach to) job `ref` for `workspaceId`. `kind`
   * selects the harness endpoint; the Cloudflare backend serves every kind, a
   * self-hosted pool only `run` (and throws a clear "unsupported" for the rest).
   *
   * Forwards the harness's {@link RunnerDispatchAck} through verbatim (undefined where the
   * backend could not see it), because the capability handshake it carries can only be acted on
   * by the caller that built the body.
   */
  async dispatch(
    workspaceId: string | undefined,
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<RunnerDispatchAck | undefined> {
    const transport = await this.resolveTransport(workspaceId)
    return (await transport.dispatch(ref, spec, kind, options)) ?? undefined
  }

  /** Poll the job's current state from the same backend it dispatched to. */
  async poll(workspaceId: string | undefined, ref: RunnerJobRef): Promise<RunnerJobView> {
    const transport = await this.resolveTransport(workspaceId)
    const view = await transport.poll(ref)
    // Stamp which backend served the job so the engine can record it in the run diagnostics.
    // A composite router (native vs. container per job) sets `view.backend` itself — its choice
    // wins; a plain transport just declares a static `backend`, applied here.
    if (!view.backend && transport.backend) return { ...view, backend: transport.backend }
    return view
  }

  /**
   * Reclaim a run's backing runner (for the Cloudflare backend, SIGKILL the per-run
   * container instead of letting it idle out its sleep timer; for a pool, cancel the
   * run's in-flight job `ref.jobId`). Best-effort and idempotent: a transport without
   * `release`, or an already-gone run/job, is a no-op.
   */
  async release(workspaceId: string | undefined, ref: RunnerJobRef): Promise<void> {
    const transport = await this.resolveTransport(workspaceId)
    await transport.release?.(ref)
  }

  /**
   * Reclaim EVERY container a run holds: one `release` per executor image the run started a
   * container on, all against the same backend.
   *
   * A per-run container backend hosts a whole run in ONE container UNLESS a step declared a
   * different image, and then there are two — so a reclaim addressing a single ref leaves the
   * other running until its maximum lifetime elapses. The images are resolved by the caller (only
   * it knows which agent kinds declared what); this owns the fan-out, which is transport
   * mechanics like every other method here.
   *
   * Concurrent, and one failure does not skip the rest: `Promise.all` starts them all, so a
   * caller treating this as best-effort still gets every container it can. The first rejection
   * propagates.
   */
  async releaseRun(
    workspaceId: string | undefined,
    run: { runId: string; jobId: string; images: readonly (RunnerImageVariant | undefined)[] },
  ): Promise<void> {
    const transport = await this.resolveTransport(workspaceId)
    await Promise.all(
      run.images.map((image) =>
        transport.release?.({ runId: run.runId, jobId: run.jobId, ...(image ? { image } : {}) }),
      ),
    )
  }

  /**
   * Stop the single in-flight job `ref.jobId` on the backend it dispatched to, and report what
   * that achieved (see {@link RunnerJobStopOutcome}).
   *
   * A transport with no `stopJob` answers `unsupported` rather than resolving quietly, because
   * the caller (the capability refusal) turns this into a statement to a human about whether an
   * agent is still working against their repository. Silence would be read as a stop.
   */
  async stopJob(workspaceId: string | undefined, ref: RunnerJobRef): Promise<RunnerJobStopOutcome> {
    const transport = await this.resolveTransport(workspaceId)
    if (!transport.stopJob) return 'unsupported'
    return transport.stopJob(ref)
  }
}
