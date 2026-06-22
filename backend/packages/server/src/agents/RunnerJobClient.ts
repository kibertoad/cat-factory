import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
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
   */
  async dispatch(
    workspaceId: string | undefined,
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const transport = await this.resolveTransport(workspaceId)
    await transport.dispatch(ref, spec, kind, options)
  }

  /** Poll the job's current state from the same backend it dispatched to. */
  async poll(workspaceId: string | undefined, ref: RunnerJobRef): Promise<RunnerJobView> {
    const transport = await this.resolveTransport(workspaceId)
    return transport.poll(ref)
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
}
