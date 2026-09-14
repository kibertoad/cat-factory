import {
  sameSubtasks,
  type AgentJobHandle,
  type DelegationHandle,
  type PipelineStep,
  type RunDelegation,
} from '@cat-factory/kernel'
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
    ...delegationHandleSlice(step),
  }
}

/**
 * The delegation record the step's IN-FLIGHT job belongs to, or undefined when the job in flight is
 * not that record's.
 *
 * The ONE question every reader of `step.delegated` actually has, and asking `if (step.delegated)`
 * instead is the shape that gets it wrong. A step whose own work was delegated can still dispatch a
 * CONTAINER job afterwards (a helper round, a re-run under an overriding kind, a PR-review `fix`
 * resolution), and the delegation record outlives that by design: its attempt log is the evidence
 * for why the step is being re-run, and `resetStepForRerun` clears `jobId` and deliberately not the
 * record. So a bare truthiness test routes that container job's poll to an external system, folds
 * its phase onto external work that finished hours ago, and settles the external record on the
 * container's outcome: three different systems' facts written onto one another.
 *
 * Keyed on the correlation key rather than on the record's status because the status is what the
 * fold is about to CHANGE; the key is what says whose job this is, which is exactly why it is
 * persisted (see `runDelegationSchema.correlationKey`).
 */
export function inFlightDelegation(step: PipelineStep): RunDelegation | undefined {
  const record = step.delegated
  if (!record || step.jobId !== record.correlationKey) return undefined
  return record
}

/**
 * The `delegated` slice of a rebuilt poll handle: which registered executor the step dispatched to
 * and what it knows about the external work.
 *
 * A delegated step's poll has NOTHING else to route on. The engine's poll site holds a step and a
 * run; the executor id lives only on this record, and without it `CompositeAgentExecutor.pollJob`
 * cannot tell a delegated step from a container one and polls a container that was never started.
 *
 * Gated on {@link inFlightDelegation}, so the slice is attached only when the job being polled IS
 * the delegated one. Without that gate a container job dispatched later on the same step is handed
 * to the external executor, which polls its system for a run that does not exist while the real
 * container job is never polled at all.
 *
 * The `externalId` FALLS BACK to the step's job id, which is the correlation key by construction
 * (the gate above makes them the same string), and that fallback is the replay case rather than an
 * edge: the claim is committed before `start()` is called, so a process that died in between
 * leaves a record with a status and no external id, and the executor is asked to recover one by
 * correlation instead of the platform starting a second external run.
 */
function delegationHandleSlice(step: PipelineStep): Pick<AgentJobHandle, 'delegated'> {
  const record = inFlightDelegation(step)
  if (!record) return {}
  return {
    delegated: {
      executor: record.executor,
      externalId: record.externalId ?? record.correlationKey,
      ...(record.url ? { url: record.url } : {}),
      ...(record.branches ? { branches: record.branches } : {}),
      ...(record.repo ? { repo: record.repo } : {}),
    },
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
  // The DELEGATION the dispatch resolved: the external id the executor answered with, and the page
  // a human watches it on. Folded here, with the rest of the attribution, because the poll site
  // rebuilds its handle from the step alone and this is the only route from the accepted dispatch
  // to it. Merged onto the CLAIM rather than replacing it, so the executor id and the attempt log
  // the claim wrote survive; the status moves to `running` because the executor has answered.
  if (handle.delegated) stampDelegationDispatch(step, handle.delegated)
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
  // A DELEGATED dispatch stamps no container, because there is none: the external executor owns
  // the machine, and `recordDispatchAttribution` above has already moved its own record on.
  // Stamping one anyway is what would make a delegated step render as a container that never
  // reports a phase, an id or an address, and be addressed by the reclaim that kills containers
  // by run.
  if (!handle.delegated) step.container = { status: 'up' }
  return handle.jobId
}

/**
 * Open the delegation record for a dispatch about to happen: the CLAIM, committed BEFORE the
 * external executor is called.
 *
 * This is the whole idempotency story for a delegated step, and the deadliest trap in the flow.
 * Both durable drivers replay, and an executor asked to start twice produces two external runs and
 * two pull requests for one task. So the engine takes the claim-before-effect half of the bargain
 * the port asks the executor for: it writes `starting` with the correlation key as the step's job
 * id, persists it, and only then dispatches. A replay finds the job id, re-attaches instead of
 * dispatching, and the poll asks the executor to recover its own run by that key.
 *
 * The attempt log APPENDS. A re-run's earlier attempts and their URLs are the evidence for why the
 * step is being re-run, and the platform holds nothing else about work that happened elsewhere.
 */
export function claimDelegation(
  step: PipelineStep,
  input: {
    executor: string
    correlationKey: string
    startedAt: number
    poll: { intervalMs: number; maxDurationMs: number }
  },
): void {
  step.jobId = input.correlationKey
  const attempts = step.delegated?.attempts ?? []
  step.delegated = {
    executor: input.executor,
    status: 'starting',
    correlationKey: input.correlationKey,
    poll: input.poll,
    externalId: null,
    url: null,
    phase: null,
    attempts: [...attempts, { startedAt: input.startedAt }],
  }
}

/** Fold an accepted dispatch onto the claim: the external id, the link, and the attempt it opened. */
function stampDelegationDispatch(
  step: PipelineStep,
  delegated: NonNullable<AgentJobHandle['delegated']>,
): void {
  // An accepted dispatch with no claim on the step cannot happen through `AgentDispatchController`
  // (the claim is what commits before `start()`), but a HELPER dispatch site that forgot to claim
  // would land here, and inventing a record is better than dropping the only link to the external
  // run. `startedAt: 0` says the platform never saw this attempt begin.
  const claim: RunDelegation = step.delegated ?? {
    executor: delegated.executor,
    status: 'starting',
    correlationKey: step.jobId ?? delegated.externalId,
    // The executor's declared cadence is unreachable from here, and inventing one would have the
    // driver poll an external system on a number nobody chose. A zero window derives the one-poll
    // floor `delegatedPollPolicy` guarantees, which settles the step on its next poll rather than
    // pretending to a budget.
    poll: { intervalMs: 0, maxDurationMs: 0 },
    attempts: [{ startedAt: 0 }],
  }
  const attempts = claim.attempts.length > 0 ? claim.attempts : [{ startedAt: 0 }]
  step.delegated = {
    ...claim,
    executor: delegated.executor,
    status: 'running',
    externalId: delegated.externalId,
    url: delegated.url ?? claim.url ?? null,
    // The branches and the TARGET repo the dispatch resolved. Persisted here, with the rest of the
    // attribution, for the reason all of it is: the poll rebuilds its handle from the step alone.
    ...(delegated.branches ? { branches: delegated.branches } : {}),
    ...(delegated.repo ? { repo: delegated.repo } : {}),
    attempts: attempts.map((attempt, index) =>
      index === attempts.length - 1
        ? {
            ...attempt,
            externalId: delegated.externalId,
            url: delegated.url ?? attempt.url ?? null,
          }
        : attempt,
    ),
  }
}

/**
 * Fold a RUNNING delegated poll onto the step, returning whether anything changed: the delegated
 * sibling of {@link applyContainerRunning}.
 *
 * Separate from it rather than one fold over both, because the two records share no field beyond a
 * status whose vocabularies differ. There is no container id to learn and no address to reach, and
 * the one thing that DOES arrive late here (the external URL, for a system that returns no run id
 * at start) has no counterpart there.
 */
export function applyDelegationRunning(
  step: PipelineStep,
  update: { url?: string; phase?: string },
): boolean {
  const prev = step.delegated
  // A running poll for a step with no record is a poll of work this engine never claimed. There is
  // nothing to fold it onto, and inventing an executor id would be a guess.
  if (!prev) return false
  const next = {
    ...prev,
    status: 'running' as const,
    url: update.url ?? prev.url ?? null,
    phase: update.phase ?? prev.phase ?? null,
  }
  if (
    prev.status === next.status &&
    (prev.url ?? null) === next.url &&
    (prev.phase ?? null) === next.phase
  ) {
    return false
  }
  step.delegated = next
  return true
}

/**
 * Every DELEGATED unit this run still has running somewhere else, as the handles their executors
 * address them by.
 *
 * Read over EVERY step rather than the current one: a run parks on one step at a time, but a
 * delegated step that failed into a retry, or one the run advanced past while its external work
 * was still winding down, is exactly the work a teardown must still name. A record that already
 * settled is excluded, because asking an executor to cancel a finished run is a request it has no
 * good answer to and the record would then claim a cancellation that did not happen.
 */
export function liveDelegations(instance: {
  id: string
  steps: readonly PipelineStep[]
}): DelegationHandle[] {
  const handles: DelegationHandle[] = []
  for (const step of instance.steps) {
    const record = step.delegated
    if (!record) continue
    if (record.status !== 'starting' && record.status !== 'running') continue
    handles.push({
      executor: record.executor,
      correlationKey: record.correlationKey,
      ...(record.externalId ? { externalId: record.externalId } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.branches ? { branches: record.branches } : {}),
      ...(record.repo ? { repo: record.repo } : {}),
      workspaceId: '',
      runId: instance.id,
      agentKind: step.agentKind,
    })
  }
  return handles
}

/**
 * Mark every live delegation `cancelled`, recording WHETHER the external work actually stopped.
 *
 * The distinction is the whole point. An executor that declares no `cancel` leaves its run alive:
 * it will finish, open its pull request and bill its tokens long after the platform has recorded
 * this run as stopped. Writing `cancelled` with nothing beside it would render a clean teardown
 * over exactly that, and the person who stopped the run is the one who needs to know to go and
 * stop it themselves.
 *
 * An unreported handle (the executor answered nothing) is treated as NOT cancelled, which is the
 * fail-safe reading: "we asked" and "it stopped" are different facts and only the executor can
 * turn the first into the second.
 */
export function applyDelegationCancellation(
  instance: { steps: readonly PipelineStep[] },
  report: readonly { correlationKey: string; cancelled: boolean; note?: string }[] | undefined,
): boolean {
  const byKey = new Map((report ?? []).map((entry) => [entry.correlationKey, entry]))
  let changed = false
  for (const step of instance.steps) {
    const record = step.delegated
    if (!record) continue
    if (record.status !== 'starting' && record.status !== 'running') continue
    const outcome = byKey.get(record.correlationKey)
    settleDelegation(step, {
      status: 'cancelled',
      outcome: outcome?.cancelled
        ? 'cancelled'
        : 'cancel requested; the external run may still be running',
      note:
        outcome?.note ??
        (outcome?.cancelled
          ? undefined
          : `This run was stopped, but "${record.executor}" could not stop the external work. ` +
            'It may still be running, and opening a pull request; stop it there if that matters.'),
    })
    changed = true
  }
  return changed
}

/**
 * Settle the delegation record on a terminal outcome, recording WHAT happened on the attempt the
 * claim opened.
 *
 * `outcome` is the executor's own words rather than a platform classification, because this record
 * is read by a person deciding whether to go and open the external logs, and "the workflow was
 * cancelled upstream" tells them something `failed` does not.
 */
export function settleDelegation(
  step: PipelineStep,
  settlement: {
    status: 'done' | 'failed' | 'cancelled'
    outcome?: string | undefined
    url?: string | undefined
    note?: string | undefined
    /**
     * The branch the work LANDED on, when the executor reported one. The product of a step whose
     * executor pushed without opening a pull request, and recorded here because the platform holds
     * nothing else about it: dropped, such a run settles as done with nothing to show for it.
     */
    branch?: string | undefined
  },
): void {
  const prev = step.delegated
  if (!prev) return
  const attempts = prev.attempts
  step.delegated = {
    ...prev,
    status: settlement.status,
    ...(settlement.url ? { url: settlement.url } : {}),
    ...(settlement.note ? { note: settlement.note } : {}),
    ...(settlement.branch ? { branch: settlement.branch } : {}),
    attempts: attempts.map((attempt, index) =>
      index === attempts.length - 1
        ? {
            ...attempt,
            ...(settlement.outcome ? { outcome: settlement.outcome } : {}),
            ...(settlement.url ? { url: settlement.url } : {}),
          }
        : attempt,
    ),
  }
}

/**
 * Settle the step's own DELEGATION on a job that finished successfully, or do nothing when the job
 * that finished was not the delegated one.
 *
 * Its own function rather than a guard plus a call at the settle site, because the whole rule is
 * the guard: the record outlives the work it describes (its attempt log is the evidence for a
 * re-run), so a CONTAINER job run later on the same step would overwrite a `failed` or `cancelled`
 * external outcome with `done`, and that record is the entire account of work that happened
 * somewhere else.
 *
 * `branch` is folded here because it is the product of an executor that pushed without opening a
 * pull request: a case the port names as legitimate, and one where dropping the branch settles the
 * run as done with nothing to show for it.
 */
export function settleDelegatedJob(
  step: PipelineStep,
  delegated: { url?: string; branch?: string } | undefined,
): void {
  if (!inFlightDelegation(step)) return
  settleDelegation(step, {
    status: 'done',
    ...(delegated?.url ? { url: delegated.url } : {}),
    ...(delegated?.branch ? { branch: delegated.branch } : {}),
  })
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
