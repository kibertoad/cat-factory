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
export function deployJobId(executionId: string, epoch: number): string {
  const base = `${executionId}-${DEPLOYER_AGENT_KIND}`
  return epoch > 0 ? `${base}-${epoch}` : base
}

/**
 * The deploy step's eviction epoch: the total number of container-eviction re-dispatches so far
 * (genuine + transient infra churn). Drives {@link deployJobId} so each eviction recovery
 * dispatches a fresh job id, analogous to the agent path's `dispatchEpochFor`.
 */
export function deployEvictionEpoch(step: PipelineStep): number {
  return (step.evictionRecoveries ?? 0) + (step.transientEvictionRecoveries ?? 0)
}
