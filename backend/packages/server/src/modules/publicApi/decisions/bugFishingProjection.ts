import type {
  BugFishingFinding,
  BugFishingPhase,
  BugFishingPlan,
  BugFishingSpawn,
  BugFishingStepState,
  PipelineStep,
  PublicBugFishingFinding,
  PublicBugFishingPhase,
  PublicBugFishingPlan,
  PublicBugFishingSpawn,
  PublicDecision,
} from '@cat-factory/contracts'

// The BUG-FISHING EXPEDITION's external projection: what the read-only `bug-fisher` agent has
// caught so far, which angles it has fished, and what a person still has to mark.
//
// Its own module rather than more of `projection.ts`, because it is a whole park kind's worth of
// shape (a plan, a phase list with its coverage record, a finding list with its spawn claims) and
// that file already carries eleven others.
//
// Two rules from `projection.ts` bind here too. Every OBJECT is projected rather than aliased, so
// an ordinary edit to the engine's `step.bugFishing` cannot become a public break; and every
// internal `optional | nullable` collapses to an always-present nullable, so four generated
// clients have one shape to check rather than "absent" and "null" to tell apart.

/**
 * Whether an expedition still wants a person.
 *
 * `awaiting_triage` is the park. `fishing` is IN FLIGHT and listed too, which is the flow's own
 * shape rather than a convenience: each angle records its findings the moment its pass lands, and
 * marking one is accepted while later angles are still being fished. A caller that only saw the
 * expedition once it parked would sit out exactly the overlap the separate passes create.
 *
 * `done` is settled and carries no question.
 */
export function isLiveBugFishing(state: BugFishingStepState): boolean {
  return state.status !== 'done'
}

/** Project a live expedition onto the external decision resource. */
export function toBugFishingDecision(
  state: BugFishingStepState,
  step: PipelineStep,
  stepIndex: number,
): PublicDecision {
  return {
    kind: 'bug-fishing',
    status: state.status,
    stepKind: step.agentKind,
    stepIndex,
    phases: (state.phases ?? []).map(toBugFishingPhase),
    currentPhaseIndex: state.currentPhaseIndex ?? 0,
    findings: (state.findings ?? []).map(toBugFishingFinding),
    plan: state.plan ? toBugFishingPlan(state.plan) : null,
    defaultFixPipelineId: state.defaultFixPipelineId ?? null,
    model: state.model ?? null,
  }
}

/**
 * One angle, externally.
 *
 * The coverage record is FLATTENED to its two numbers rather than passed through as an object.
 * `offManifest` and `source` are the engine's own audit of the agent's self-report, which a caller
 * deciding whether an angle actually looked at anything cannot act on; the share it can act on is
 * `filesRead` against `manifestFiles`. Both are null together when the pass reported no coverage
 * at all, which is a different fact from a share of zero and is why they are nullable rather than
 * defaulted.
 */
function toBugFishingPhase(phase: BugFishingPhase): PublicBugFishingPhase {
  return {
    phaseId: phase.id,
    title: phase.title,
    goal: phase.goal,
    status: phase.status,
    summary: phase.summary ?? null,
    failureReason: phase.failureReason ?? null,
    territoryId: phase.territoryId ?? null,
    territoryLabel: phase.territoryLabel ?? null,
    settledAt: phase.settledAt ?? null,
    filesRead: phase.coverage?.filesRead ?? null,
    manifestFiles: phase.coverage?.manifestFiles ?? null,
  }
}

/**
 * The plan, externally: the budget, the matrix it was cut from, and the cells nobody fished.
 *
 * The TERRITORIES themselves are deliberately not projected. A caller reads a territory only to
 * name the ground a finding or an unfished cell belongs to, and both of those carry the label they
 * were recorded under; the descriptor list beside them would add root paths, subtree shas and a
 * token estimate that describe how the platform sized the hunt rather than what it found.
 */
function toBugFishingPlan(plan: BugFishingPlan): PublicBugFishingPlan {
  return {
    passBudget: plan.passBudget,
    plannedCells: plan.plannedCells,
    unfished: (plan.unfished ?? []).map((cell) => ({
      territoryId: cell.territoryId,
      territoryLabel: cell.territoryLabel,
      phaseId: cell.phaseId,
      phaseTitle: cell.phaseTitle,
    })),
    treeTruncated: plan.treeTruncated ?? false,
    surveyUnavailableReason: plan.surveyUnavailableReason ?? null,
  }
}

/** One finding, externally. Every string on it is model-authored; nothing here composes markup. */
function toBugFishingFinding(finding: BugFishingFinding): PublicBugFishingFinding {
  return {
    findingId: finding.id,
    phaseId: finding.phaseId,
    territoryId: finding.territoryId ?? null,
    path: finding.path,
    line: finding.line ?? null,
    severity: finding.severity,
    kind: finding.kind,
    confidence: finding.confidence,
    title: finding.title,
    detail: finding.detail,
    failureScenario: finding.failureScenario ?? null,
    evidence: finding.evidence ?? null,
    suggestedFix: finding.suggestedFix ?? null,
    spawn: finding.spawn ? toBugFishingSpawn(finding.spawn) : null,
    dismissed: finding.dismissed ?? false,
  }
}

/**
 * A marked finding's spawn record, externally.
 *
 * `requestedBy` is dropped: it is a `usr_*` this surface resolves to nothing, and a key is not a
 * person, so a marking made over `/api/v1` records no requester at all. Publishing the field would
 * put a null beside every externally-marked finding that reads as "nobody", which is true of the
 * key's markings and false of the app's.
 */
function toBugFishingSpawn(spawn: BugFishingSpawn): PublicBugFishingSpawn {
  return {
    status: spawn.status,
    taskId: spawn.taskId,
    executionId: spawn.executionId ?? null,
    pipelineId: spawn.pipelineId,
    requestedAt: spawn.requestedAt,
    failureReason: spawn.failureReason ?? null,
  }
}
