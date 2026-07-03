import type { PipelineStep } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'

/**
 * The deterministic, replay-stable job id for a `deployer` step's container-backed deploy job.
 * Mirrors the agent executor's `stepJobId`: a Workflows replay of the dispatch step reproduces
 * the SAME id, so the runner transport (idempotent per ref) re-attaches to the in-flight deploy
 * container instead of starting a duplicate. A random id (the old `idGenerator.next('deploy')`)
 * would change on a replay that threw after dispatch but before persisting `step.jobId`, leaving
 * the first container orphaned and re-applying kustomize/helm. The eviction epoch keeps each
 * re-dispatch AFTER a container eviction distinct, so a fresh job can't re-attach to the dead
 * container's already-completed job.
 */
export function deployJobId(executionId: string, epoch: number, frameId?: string): string {
  // A multi-env deploy fans out one job PER service frame (the task's own + each involved
  // service), so the frame id discriminates the otherwise-identical per-run ids. A single-frame
  // deploy passes no frame and keeps the historical `<runId>-deployer[-epoch]` shape.
  const base = `${executionId}-${DEPLOYER_AGENT_KIND}${frameId ? `-${frameId}` : ''}`
  return epoch > 0 ? `${base}-${epoch}` : base
}

/**
 * Order a multi-env deploy's target service frames PROVIDER-BEFORE-CONSUMER: a frame is emitted
 * only once every frame it CONNECTS TO (uses) that is also a target has been emitted, so a later
 * provision can be handed its already-ready peers' URLs (the cross-injection in
 * `deployerProvisionArgs`). `providersOf` maps each target frame id to the set of target frame ids
 * it uses (its consumer→provider connection edges, pre-filtered to the target set). Deterministic
 * tie-break: the PRIMARY (own) frame first, then ascending frame id. Connection cycles are legal
 * (see the initiative) — when no frame is fully unblocked the cycle is broken by emitting the same
 * deterministic pick, so ordering always makes progress.
 */
export function orderProvisionTargets(
  targets: ReadonlyArray<{ frameId: string; isPrimary: boolean }>,
  providersOf: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const meta = new Map(targets.map((t) => [t.frameId, t]))
  const remaining = new Set(targets.map((t) => t.frameId))
  const before = (a: string, b: string): number => {
    const pa = meta.get(a)?.isPrimary ? 0 : 1
    const pb = meta.get(b)?.isPrimary ? 0 : 1
    if (pa !== pb) return pa - pb
    return a < b ? -1 : a > b ? 1 : 0
  }
  const order: string[] = []
  while (remaining.size > 0) {
    let ready = [...remaining].filter((id) => {
      const providers = providersOf.get(id)
      return !providers || ![...providers].some((p) => remaining.has(p))
    })
    // A cycle among the remaining frames: none is fully unblocked. Break it deterministically.
    if (ready.length === 0) ready = [...remaining]
    ready.sort(before)
    const pick = ready[0]!
    order.push(pick)
    remaining.delete(pick)
  }
  return order
}

/**
 * The deploy step's eviction epoch: the total number of container-eviction re-dispatches so far
 * (genuine + transient infra churn). Drives {@link deployJobId} so each eviction recovery
 * dispatches a fresh job id, analogous to the agent path's `dispatchEpochFor`.
 */
export function deployEvictionEpoch(step: PipelineStep): number {
  return (step.evictionRecoveries ?? 0) + (step.transientEvictionRecoveries ?? 0)
}
