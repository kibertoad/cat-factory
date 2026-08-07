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
 * Rebuild the job handle a settled/running POLL addresses, from the step alone.
 *
 * The exact counterpart of {@link recordDispatchAttribution}, and here for the same reason it is:
 * the poll site has no dispatch in scope, so everything the executor needs off the handle has to
 * be read back from what the dispatch persisted. Each field is load-bearing on the container
 * executor:
 *
 *  - `agentKind` — `toRunResult` maps a migrated `merger`/`on-call`'s structured result into
 *    `mergeAssessment`/`onCallAssessment` KIND-AWARE, so without it the coercion no-ops and the
 *    merge gate / post-release-health gate see no assessment at all;
 *  - `runId` — the executor addresses the same per-run container; the step stored only a job id;
 *  - `model` — absent, `recordStepResult` records 'unknown', which `SpendService.parseModel`
 *    splits into provider "unknown" / model "", corrupting the `token_usage` row of EVERY
 *    subscription-harness step;
 *  - `subscriptionTokenId` — gates the pooled-token usage feedback that drives usage-aware
 *    rotation; absent, it is skipped outright;
 *  - `initiatedByUserId` — the quota-cycle counters' fallback target for a PERSONAL
 *    (individual-usage) run, which leases no pooled token; absent, the target is null.
 */
export function pollHandleFor(
  step: PipelineStep,
  workspaceId: string,
  executionId: string,
): AgentJobHandle {
  return {
    jobId: step.jobId!,
    runId: executionId,
    workspaceId,
    agentKind: step.agentKind,
    model: step.model,
    subscriptionTokenId: step.subscriptionTokenId,
    initiatedByUserId: step.initiatedByUserId,
  }
}

/**
 * Persist the attribution a DISPATCH knows and the poll site cannot re-derive: the resolved
 * model, plus (for a subscription-harness job) the leased pool row and the run's initiator,
 * plus the agent kind the job actually ran AS.
 *
 * An async container job settles on the durable poll path, which rebuilds the job handle from
 * the step alone — so anything not recorded here is lost by the time the usage lands. Dropping
 * the model made every subscription step's `token_usage` row read provider "unknown"; dropping
 * the other two silently skips the pooled-token usage feedback (usage-aware rotation) and leaves
 * the quota-cycle counters with no target. Each field is written only when the handle carries it,
 * so a re-dispatch that resolves less never erases what an earlier one knew.
 *
 * `dispatchedKind` is a REQUIRED parameter rather than something read off the step, because
 * `step.agentKind` is routinely not what ran: a gate escalates to its helper, a Tester hands off
 * to the fixer, a two-phase coder proposes forks first. Every telemetry row that job produces is
 * tagged with the dispatched kind, so a consumer grouping by kind (the external trace's step
 * spans) has nothing to attach to unless the run records it. Being a parameter is the point: a
 * new dispatch site cannot compile without answering the question, which is the same reason this
 * function exists at all.
 */
export function recordDispatchAttribution(
  step: PipelineStep,
  handle: AgentJobHandle,
  dispatchedKind: string,
): void {
  if (handle.model) step.model = handle.model
  if (handle.subscriptionTokenId) step.subscriptionTokenId = handle.subscriptionTokenId
  if (handle.initiatedByUserId) step.initiatedByUserId = handle.initiatedByUserId
  // What the agent could actually call, STAMPED with the kind that was dispatched. The stamp is
  // applied here rather than by the executor for the same reason `dispatchedKind` is a parameter:
  // a helper re-dispatch on this step (a gate's `ci-fixer`, the tester's `fixer`, a fork's second
  // phase) resolves its OWN kind's declarations and overwrites this record, and a reader would
  // otherwise take the lists for the step's named kind and report a different agent's
  // capabilities.
  //
  // Written whenever the handle carries it, including when BOTH lists are empty, which is a kind
  // declaring no tool servers and is exactly the state an executor that resolves none is
  // reporting. Guarded on presence rather than on content, like every other field here, so a
  // re-dispatch by an executor that wires no tool servers (the inline path picking up a step a
  // container path started) never erases the container round's record.
  if (handle.toolServers) step.toolServers = { ...handle.toolServers, agentKind: dispatchedKind }
  // Order-preserving by FIRST dispatch, counting every one after it: the count is what makes a
  // gate's fourth fixer round visible, so a re-dispatch increments rather than deduplicating.
  const dispatches = step.dispatches ?? []
  const existing = dispatches.find((d) => d.agentKind === dispatchedKind)
  step.dispatches = existing
    ? dispatches.map((d) => (d === existing ? { ...d, count: d.count + 1 } : d))
    : [...dispatches, { agentKind: dispatchedKind, count: 1 }]
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
