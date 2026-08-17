import { sameSubtasks, type AgentJobHandle, type PipelineStep } from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
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
  if (handle.toolServers) stampToolServers(step, handle.toolServers, dispatchedKind)
  // Order-preserving by FIRST dispatch, counting every one after it: the count is what makes a
  // gate's fourth fixer round visible, so a re-dispatch increments rather than deduplicating.
  const dispatches = step.dispatches ?? []
  const existing = dispatches.find((d) => d.agentKind === dispatchedKind)
  step.dispatches = existing
    ? dispatches.map((d) => (d === existing ? { ...d, count: d.count + 1 } : d))
    : [...dispatches, { agentKind: dispatchedKind, count: 1 }]
}

/**
 * Every agent kind this run has DISPATCHED, read off the same `step.dispatches` counter
 * {@link recordDispatchAttribution} writes and {@link dispatchEpochFor} counts.
 *
 * It answers the run-level reclaim's question ("which containers does this run hold"), which
 * `step.agentKind` cannot: a gate escalates to its helper and a Tester hands off to the fixer, so
 * the kind a step DECLARES is routinely not the one that opened a container. Reading the persisted
 * counter also means a reclaim after a durable replay, in a process that saw none of those
 * dispatches, still names them all.
 */
export function dispatchedAgentKinds(instance: { steps: readonly PipelineStep[] }): string[] {
  const kinds = new Set<string>()
  for (const step of instance.steps) {
    for (const entry of step.dispatches ?? []) kinds.add(entry.agentKind)
  }
  return [...kinds]
}

/**
 * The dispatch epoch for the NEXT job of `dispatchedKind` in this run: how many jobs of that kind
 * the run has already dispatched (see `AgentRunContext.dispatchEpoch`). The container
 * executor suffixes its harness job id with it, so `<runId>-<agentKind>[-epoch]` names the n-th
 * job of that kind in the run and every dispatch gets an id of its own.
 *
 * That matters because the harness re-attaches to an EXISTING job id rather than re-running
 * (replay idempotency), and a container-reusing transport — a warm local pool, a self-hosted
 * runner pool — keeps its `JobRegistry` alive across rounds, since reclaiming a pooled member does
 * NOT destroy it. A pool is also asked to route STICKY BY JOB ID (`runner-pool-integration.md` §7),
 * which is right for a live job and exactly wrong afterwards. So a re-dispatch under a used id
 * REPLAYS the earlier job's completed result: same output, same recorded usage, no model call.
 * Every loop in the engine that re-dispatches is exposed to that, and each one it reached read
 * either as work that "passed regardless" (the Tester re-test that never re-tested) or as a loop
 * that could not converge (a companion re-grading a byte-identical artifact and never moving 0.76).
 *
 * Read off {@link recordDispatchAttribution}'s counter, which is the whole design: that is the one
 * funnel EVERY dispatch site already calls, it counts the same `dispatchedKind` string the job id
 * is built from, and `resetStepForRerun` deliberately never clears it. So the epoch is monotonic by
 * construction and total over the loops: a new re-dispatching mechanism (a companion rework round,
 * a tester quality re-run, a human's second fix request, whatever comes next) needs no counter of
 * its own and no registration anywhere.
 *
 * It replaced a hand-summed list of six per-loop counters (`test.attempts`, `gate.attempts`,
 * `ralph.attempts`, eviction recoveries, PR-review resumes, a fork-phase bump), which was wrong in
 * both directions: a loop nobody added left the epoch pinned at 0, and `ralph.attempts` is ZEROED
 * by `restartRalphState` on a loop-back, so a summed epoch could go DOWN onto an id the harness
 * already held. Counting across EVERY step, not just the dispatching one, is what makes the id
 * unique within the RUN rather than within the step: `fixer` is dispatched as a helper off four
 * different steps, and two of them requesting one fix each would otherwise both mint `<run>-fixer`.
 */
export function dispatchEpochFor(
  instance: { steps: readonly PipelineStep[] },
  dispatchedKind: string,
): number {
  let dispatched = 0
  for (const step of instance.steps) {
    for (const entry of step.dispatches ?? []) {
      if (entry.agentKind === dispatchedKind) dispatched += entry.count
    }
  }
  return dispatched
}

/**
 * The `dispatchEpoch` slice of an agent context: {@link dispatchEpochFor}'s count, and nothing at
 * all for the run's FIRST job of a kind. Absent and 0 mean the same thing to the container executor
 * (the job id keeps its unsuffixed shape), and a spread-ready partial keeps that equivalence here,
 * beside the counter, rather than as a conditional at the one call site that builds the context.
 */
export function dispatchEpochSlice(
  instance: { steps: readonly PipelineStep[] },
  dispatchedKind: string,
): { dispatchEpoch?: number } {
  const dispatchEpoch = dispatchEpochFor(instance, dispatchedKind)
  return dispatchEpoch > 0 ? { dispatchEpoch } : {}
}

/**
 * Record what an INLINE dispatch will do with the running kind's tool servers (MCP).
 *
 * The counterpart of the `handle.toolServers` fold above on the path that returns a RESULT instead
 * of a job handle. Its one producer today is a consensus-diverted step: the panel runs as inline
 * model calls with no agent CLI, so every server the kind declared is withheld, and without this
 * the step would carry no record at all and read exactly like a kind that declared none.
 *
 * Called BEFORE the inline call, off `AgentExecutor.previewToolServers`, so the two paths record on
 * the same terms: the container path stamps off the handle at dispatch, and a job that later fails
 * keeps its record. Folding an inline resolution off the RESULT instead would drop it on exactly
 * the runs a reader most needs it for, since a failed step returns no result to carry it.
 *
 * `dispatchedKind` is a parameter here for the same reason it is there, and it is what keeps the
 * stamp out of the executor's hands: the engine names the kind it dispatched, so a resolution can
 * never be labelled with another one. Guarded on presence, so an inline executor with nothing to
 * report never erases a record an earlier container round on this step wrote.
 */
export function recordInlineToolServers(
  step: PipelineStep,
  resolved: DispatchToolServers | undefined,
  dispatchedKind: string,
): void {
  if (resolved) stampToolServers(step, resolved, dispatchedKind)
}

/**
 * Put one dispatch's tool-server resolution on the step under the kind that ran.
 *
 * Shared by the container and inline folds rather than spelled out at each, because the STAMP is
 * the invariant: the executor reports two lists and the engine alone says whose they are (see
 * `DispatchToolServers`). Two spellings of it is two places for an executor-supplied kind to creep
 * back in.
 */
function stampToolServers(
  step: PipelineStep,
  resolved: DispatchToolServers,
  dispatchedKind: string,
): void {
  step.toolServers = { ...resolved, agentKind: dispatchedKind }
}

/**
 * Record an ACCEPTED container dispatch on the step: the job handle to poll, the attribution
 * only the dispatch site can resolve ({@link recordDispatchAttribution}), and the container
 * projection the board reads.
 *
 * One helper rather than three lines at each of the six dispatch sites, because the middle line
 * is the one that goes missing. `recordDispatchAttribution` persists the resolved model, the
 * leased `subscriptionTokenId` and the run's `initiatedByUserId`, and the job settles on the
 * durable poll path, which rebuilds its handle from the STEP alone: an omission is invisible in
 * testing and surfaces in production as attribution landing on "unknown"/nobody, never as an
 * error. Two sites carried duplicated comments warning about exactly that. Going through one
 * function makes the warning structural.
 *
 * `dispatchedKind` stays a required parameter for the reason its callee documents: `step.agentKind`
 * is routinely not what ran (a gate escalates to its helper, a Tester hands off to its fixer).
 *
 * The container is marked `up` because the dispatch RETURNED, which is the only thing known here;
 * the live phase and the container id/url arrive on the first poll. A finished cold boot must not
 * linger as a stale "spinning up".
 *
 * Returns the stamped job id, so a caller that must report `awaiting_job` from OUTSIDE the branch
 * that dispatched holds a `string` rather than re-reading the now-optional `step.jobId`.
 */
export function recordDispatchedJob(
  step: PipelineStep,
  handle: AgentJobHandle,
  dispatchedKind: string,
): string {
  step.jobId = handle.jobId
  recordDispatchAttribution(step, handle, dispatchedKind)
  step.container = { status: 'up' }
  return handle.jobId
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
