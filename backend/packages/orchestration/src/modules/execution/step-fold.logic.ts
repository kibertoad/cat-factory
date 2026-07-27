import { sameSubtasks, type AgentJobHandle, type PipelineStep } from '@cat-factory/kernel'
import { shouldPersistActivity } from './job.logic.js'

// The "fold one job update onto the step" family: the small, pure-ish mutators the poll paths
// (agent + deployer) apply to a running step, each returning whether anything actually changed so
// the caller only persists + emits on a real delta. Extracted from `RunDispatcher` — they never
// touched `this`, they are shared by two poll paths, and the family grew a fourth member when the
// pre-PR validation report started republishing live (see `validation.logic.ts`, which owns that
// one because it also parses the harness payload). {@link recordDispatchAttribution} is the one
// member folding a DISPATCH rather than a poll — it lives here because every dispatch site needs
// it and it is the exact counterpart the poll site reads back.

/**
 * Persist the attribution a DISPATCH knows and the poll site cannot re-derive: the resolved
 * model, plus (for a subscription-harness job) the leased pool row and the run's initiator.
 *
 * An async container job settles on the durable poll path, which rebuilds the job handle from
 * the step alone — so anything not recorded here is lost by the time the usage lands. Dropping
 * the model made every subscription step's `token_usage` row read provider "unknown"; dropping
 * the other two silently skips the pooled-token usage feedback (usage-aware rotation) and leaves
 * the quota-cycle counters with no target. Each field is written only when the handle carries it,
 * so a re-dispatch that resolves less never erases what an earlier one knew.
 */
export function recordDispatchAttribution(step: PipelineStep, handle: AgentJobHandle): void {
  if (handle.model) step.model = handle.model
  if (handle.subscriptionTokenId) step.subscriptionTokenId = handle.subscriptionTokenId
  if (handle.initiatedByUserId) step.initiatedByUserId = handle.initiatedByUserId
}

export function applyContainerRunning(
  step: PipelineStep,
  update: { phase?: string; container?: { id?: string; url?: string } },
): boolean {
  const prev = step.container ?? undefined
  const next = {
    status: 'up' as const,
    phase: update.phase ?? prev?.phase ?? null,
    id: update.container?.id ?? prev?.id ?? null,
    url: update.container?.url ?? prev?.url ?? null,
  }
  if (
    prev?.status === next.status &&
    (prev?.phase ?? null) === next.phase &&
    (prev?.id ?? null) === next.id &&
    (prev?.url ?? null) === next.url
  ) {
    return false
  }
  step.container = next
  return true
}

/**
 * Apply an async step's live subtask counts to the step (and the derived 0..1 progress
 * fraction), returning whether anything changed. Shared by {@link pollAgentJob} (the agent
 * executor's `update.subtasks`) and the {@link DeployerStepController} poll (the deploy job's
 * `view.progress`)
 * so the progress-fraction math lives in one place.
 */
export function applySubtaskProgress(
  step: PipelineStep,
  counts: PipelineStep['subtasks'],
): boolean {
  if (!counts || sameSubtasks(step.subtasks, counts)) return false
  step.subtasks = counts
  step.progress = counts.total > 0 ? counts.completed / counts.total : 0
  return true
}

/**
 * Fold a running poll's forwarded liveness heartbeat onto `step.lastActivityAt`, THROTTLED via
 * {@link shouldPersistActivity}: re-stamped only once the heartbeat has advanced by a bounded
 * window (not on every ~15s poll), and never when a wedged job's heartbeat is frozen — so its
 * `updated_at` correctly stops advancing. Returns whether it changed, so the caller persists +
 * emits (refreshing the run's `updated_at` and the UI's "active Ns ago") only on a real advance.
 */
export function applyLastActivity(step: PipelineStep, incoming: number | undefined): boolean {
  if (!shouldPersistActivity(step.lastActivityAt, incoming)) return false
  step.lastActivityAt = incoming
  return true
}
