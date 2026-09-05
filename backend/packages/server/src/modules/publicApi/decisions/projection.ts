import {
  type AgentKindRegistry,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
} from '@cat-factory/agents'
import {
  dedicatedParkSurface,
  findParkedInterviewStep,
  followUpLoopBudget,
} from '@cat-factory/orchestration'
import type { InterviewView } from '@cat-factory/orchestration'
import type { GateRegistry } from '@cat-factory/kernel'
import { blockingReviewComments } from '@cat-factory/contracts'
import type {
  BrainstormSession,
  BrainstormStage,
  ClarityReview,
  Decision,
  ExecutionInstance,
  FollowUpsStepState,
  ForkDecisionStepState,
  HumanTestStepState,
  JudgeStepState,
  PipelineStep,
  PrReviewFinding,
  PrReviewSlice,
  PrReviewStepState,
  PublicDecision,
  PublicDecisionList,
  PublicPrReviewFinding,
  PublicPrReviewSlice,
  PublicUnanswerableWait,
  RequirementReview,
  RunInputGate,
  StepApproval,
  VisualConfirmStepState,
} from '@cat-factory/contracts'
import type { Context } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import type { ScopedRun } from './scope.js'

// The run → `PublicDecisionList` projection: what a parked run is currently asking a human, as
// external resources. One `to*Decision` + one `isLive*` predicate per park kind, and the assembly
// that decides which reads a given run even needs.
//
// Two rules hold across every kind here:
//
//  1. **A settled park is not a decision.** A predicate lists the park's own waiting state plus
//     the in-flight states either side of it, so a poller sees progress rather than an empty list
//     that reads as "nothing is happening" — but never a terminal state, which would put a
//     question in front of a caller with nothing left to answer.
//  2. **Project as data, never as prose.** Every one of these carries model-authored text
//     (a proposal, a finding, an agent's question). It crosses the wire as its own field so a
//     consumer can render it in its own surface; nothing here composes it into markdown.

/** Project a live requirements review onto the external decision resource. */
function toRequirementsDecision(review: RequirementReview): PublicDecision {
  return {
    kind: 'requirements-review',
    reviewId: review.id,
    taskId: review.blockId,
    status: review.status,
    iteration: review.iteration ?? 1,
    maxIterations: review.maxIterations ?? 1,
    findings: review.items.map(toFinding),
    incorporatedRequirements: review.incorporatedRequirements,
  }
}

/** Project a live clarity (bug-triage) review — the requirements twin over its own document. */
function toClarityDecision(review: ClarityReview): PublicDecision {
  return {
    kind: 'clarity-review',
    reviewId: review.id,
    taskId: review.blockId,
    status: review.status,
    iteration: review.iteration ?? 1,
    maxIterations: review.maxIterations ?? 1,
    findings: review.items.map(toFinding),
    clarifiedReport: review.clarifiedReport,
  }
}

/** Project a live brainstorm session for one stage. */
function toBrainstormDecision(session: BrainstormSession): PublicDecision {
  return {
    kind: 'brainstorm',
    sessionId: session.id,
    stage: session.stage,
    taskId: session.blockId,
    status: session.status,
    iteration: session.iteration ?? 1,
    maxIterations: session.maxIterations ?? 1,
    options: session.items.map(toFinding),
    convergedDirection: session.convergedDirection,
  }
}

/**
 * The shared item projection for all three iterative-review kinds. They persist the SAME item
 * shape (`requirementReviewItemSchema`) on purpose, so one projection is the honest expression of
 * that rather than three copies waiting to drift. The internal `autoAnswerable` classification and
 * the Requirement-Writer recommendation machinery stay off it: both drive in-app affordances.
 */
function toFinding(item: RequirementReview['items'][number]) {
  return {
    itemId: item.id,
    category: item.category,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    status: item.status,
    reply: item.reply,
  }
}

/** Project a run's fork-decision step state onto the external decision resource. */
function toForkDecision(state: ForkDecisionStepState): PublicDecision {
  return {
    kind: 'fork',
    status: state.status,
    seamSummary: state.seamSummary ?? null,
    forks: state.forks ?? [],
  }
}

/**
 * Project a run's JUDGE step state onto the external decision resource. The rubric body is
 * deliberately omitted (see `publicJudgeDecisionSchema`) — a caller answers the findings.
 */
function toJudgeDecision(stepKind: string, state: JudgeStepState): PublicDecision {
  return {
    kind: 'judge',
    stepKind,
    status: state.status,
    rubricId: state.rubricId ?? null,
    rubricName: state.rubricName ?? null,
    threshold: state.threshold ?? null,
    verdict: state.verdict ?? null,
    bounces: state.bounces ?? 0,
    maxBounces: state.maxBounces ?? 0,
  }
}

/**
 * Project a step's APPROVAL GATE. `exceeded` is read off the step's companion state rather than
 * the approval itself, because that is where the engine records it — and it is what tells a caller
 * to answer with `resolve-exceeded` instead of `approve`. Reading it as a plain boolean (rather
 * than only when a companion exists) means an ordinary pipeline gate reports `false`, which is the
 * true statement, not an omission.
 *
 * `blockingFindings` comes from the LATEST verdict, which is the round that parked: it is what a
 * `proceed` would overrule, and the `proposal` beside it cannot state it (a companion's summary is a
 * verdict and is forbidden from restating its own findings). Read through the shared
 * `blockingReviewComments` so the API cannot count a must-fix the engine did not.
 */
function toApprovalDecision(
  step: PipelineStep,
  stepIndex: number,
  approval: StepApproval,
): PublicDecision {
  return {
    kind: 'approval-gate',
    approvalId: approval.id,
    stepKind: step.agentKind,
    stepIndex,
    status: approval.status,
    proposal: approval.proposal,
    feedback: approval.feedback ?? null,
    // The quorum, as SNAPSHOTTED on the gate when it was raised — never re-derived from the
    // pipeline, which stays editable while the run is parked. Projected because a quorum makes
    // `approve` legitimately not advance the run, and without the tally a caller could not tell
    // that from a call that failed.
    requiredApprovals: approval.requiredApprovals ?? 1,
    recordedApprovals: approval.approvals?.length ?? 0,
    exceeded: step.companion?.exceeded === true,
    blockingFindings: blockingReviewComments(step.companion?.verdicts.at(-1)?.comments).map(
      (finding) => ({ body: finding.body, anchorId: finding.anchorId ?? null }),
    ),
  }
}

/** Project a decision an agent raised mid-work. */
function toAgentDecision(step: PipelineStep, decision: Decision): PublicDecision {
  return {
    kind: 'agent-decision',
    decisionId: decision.id,
    stepKind: step.agentKind,
    question: decision.question,
    options: decision.options,
  }
}

/**
 * Project a parked PR deep review's curation state.
 *
 * The slices and findings go through their own projections rather than crossing the wire as the
 * engine holds them: the internal shapes are mid-evolution (per-slice resume reports) while the
 * published ones must not move, and the `optional | null` internals collapse to always-present
 * nullables so four generated clients have one shape to check.
 */
function toPrReviewDecision(state: PrReviewStepState): PublicDecision {
  return {
    kind: 'pr-review',
    status: state.status,
    summary: state.summary ?? null,
    prUrl: state.prUrl ?? null,
    slices: (state.slices ?? []).map(toPrReviewSlice),
    findings: (state.findings ?? []).map(toPrReviewFinding),
    selectedFindingIds: state.selectedFindingIds ?? [],
  }
}

/** One reviewed slice, externally. */
function toPrReviewSlice(slice: PrReviewSlice): PublicPrReviewSlice {
  return {
    sliceId: slice.id,
    title: slice.title,
    rationale: slice.rationale,
    paths: slice.paths,
  }
}

/**
 * One review finding, externally. The challenge is projected rather than passed through so a
 * caller sees the VERDICT and its justification without the engine's job bookkeeping.
 */
function toPrReviewFinding(finding: PrReviewFinding): PublicPrReviewFinding {
  const challenge = finding.challenge
  return {
    findingId: finding.id,
    sliceId: finding.sliceId ?? null,
    path: finding.path,
    line: finding.line ?? null,
    side: finding.side ?? null,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    detail: finding.detail,
    suggestedFix: finding.suggestedFix ?? null,
    challenge: challenge
      ? {
          status: challenge.status,
          question: challenge.question ?? null,
          justification: challenge.justification ?? null,
        }
      : null,
  }
}

/** Project a parked human-test gate: what to test against, and how much fix budget is left. */
function toHumanTestDecision(state: HumanTestStepState): PublicDecision {
  const env = state.environment
  return {
    kind: 'human-test',
    phase: state.phase,
    environment: env
      ? { url: env.url, status: env.status, expiresAt: env.expiresAt ?? null }
      : null,
    degradedReason: state.degradedReason ?? null,
    attempts: state.attempts,
    maxAttempts: state.maxAttempts,
  }
}

/** Project a parked visual-confirmation gate: the pairings awaiting a verdict. */
function toVisualConfirmDecision(state: VisualConfirmStepState): PublicDecision {
  return {
    kind: 'visual-confirmation',
    phase: state.phase,
    pairs: (state.pairs ?? []).map((pair) => ({
      view: pair.view,
      actualArtifactId: pair.actualArtifactId ?? null,
      referenceArtifactId: pair.referenceArtifactId ?? null,
    })),
    degradedReason: state.degradedReason ?? null,
    attempts: state.attempts,
    maxAttempts: state.maxAttempts,
  }
}

/**
 * Whether a judge state is something the caller can still act on. `awaiting_decision` is the
 * park; `evaluating`/`bouncing` are in flight and worth surfacing so a poller sees progress
 * rather than an empty list that reads as "nothing is happening". A `passed`/`failed`/`skipped`
 * judge is settled and carries no question.
 */
function isLiveJudge(state: JudgeStepState): boolean {
  return (
    state.status === 'awaiting_decision' ||
    state.status === 'evaluating' ||
    state.status === 'bouncing'
  )
}

/**
 * Whether an iterative review (requirements / clarity / brainstorm — one lifecycle, one
 * predicate) is something the caller can still act on. A settled review (`incorporated`) is
 * history: it is the document downstream agents implement, not a question, so it is dropped from
 * the list rather than presented as answerable. `incorporating`/`reviewing` ARE listed: the driver
 * is mid-cycle and the caller should see that its answers are in flight.
 */
function isLiveReview(review: { status: RequirementReview['status'] }): boolean {
  return review.status !== 'incorporated'
}

/**
 * Whether the fork state is something the caller can still act on. `awaiting_choice` is the park;
 * `proposing`/`answering` are in-flight and worth surfacing so a poller sees progress. A `chosen`,
 * `single_path` or `skipped` state is settled and carries no question.
 */
function isLiveFork(state: ForkDecisionStepState): boolean {
  return (
    state.status === 'awaiting_choice' ||
    state.status === 'proposing' ||
    state.status === 'answering'
  )
}

/**
 * Whether a PR deep review still wants a human. `awaiting_selection` is the park; `reviewing`,
 * `challenging`, `fixing` and `posting` are work in flight a poller should see. `done`/`skipped`
 * are settled.
 */
function isLivePrReview(state: PrReviewStepState): boolean {
  return state.status !== 'done' && state.status !== 'skipped'
}

/**
 * Whether a human-test gate still wants a person. `awaiting_human` is the park; `provisioning`,
 * `fixing` and `resolving_conflicts` are work in flight a poller should see; `passed` is settled.
 *
 * An EXHAUSTIVE switch rather than `phase !== 'passed'`, because the interesting direction is the
 * one a negative test gets silently wrong: a phase added later (a `failed`, an `expired`) is
 * terminal more often than not, and `!== 'passed'` would list it as a live question forever with
 * nothing failing. Routed through {@link unclassifiedPhase} so the build breaks until somebody
 * says which side the new phase is on.
 */
function isLiveHumanTest(state: HumanTestStepState): boolean {
  switch (state.phase) {
    case 'awaiting_human':
    case 'provisioning':
    case 'fixing':
    case 'resolving_conflicts':
      return true
    case 'passed':
      return false
    default:
      return unclassifiedPhase(state.phase)
  }
}

/**
 * Whether a visual-confirmation gate still wants a person. `awaiting_human` is the park, `fixing`
 * is in flight, `approved` is settled. Exhaustive for the reason {@link isLiveHumanTest} is, and
 * the pending phase is not hypothetical here: the internal schema's own comment records a
 * `capturing` phase deferred until the re-capture loop is wired.
 */
function isLiveVisualConfirm(state: VisualConfirmStepState): boolean {
  switch (state.phase) {
    case 'awaiting_human':
    case 'fixing':
      return true
    case 'approved':
      return false
    default:
      return unclassifiedPhase(state.phase)
  }
}

/**
 * A gate phase this projection has no verdict for. Unreachable by TYPE: reaching it means a
 * member was added to the picklist without being classified above, which is a build failure at the
 * call site rather than a runtime branch.
 *
 * It still answers at runtime, because the type is total against the SCHEMA and only partial
 * against the DATA: a row persisted by a newer build lands here. `false` is the safe answer, as a
 * phase nobody classified is not something to put in front of a caller as an open question.
 */
function unclassifiedPhase(_phase: never): boolean {
  return false
}

/**
 * Project a step's FOLLOW-UP TRIAGE state: every item the Coder surfaced, decided ones included.
 *
 * The whole list rather than only the `pending` ones, because a caller triaging item by item has
 * to see what it already decided (and what a filed item became) to know what is left, and the
 * list is bounded by what one Coder pass streamed.
 *
 * The send-back budget comes from the engine's own {@link followUpLoopBudget} rather than being
 * re-defaulted here: a caller reads these two numbers to decide whether a `send-back` will actually
 * re-run the Coder, so reporting a ceiling the gate would not honour is worse than reporting none.
 */
function toFollowUpsDecision(
  step: PipelineStep,
  stepIndex: number,
  state: FollowUpsStepState,
): PublicDecision {
  return {
    kind: 'follow-ups',
    stepKind: step.agentKind,
    stepIndex,
    items: state.items.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      suggestedAction: item.suggestedAction ?? null,
      status: item.status,
      answer: item.answer ?? null,
      sendBackDropped: item.sendBackDropped ?? false,
      ticketExternalId: item.ticketExternalId ?? null,
      ticketUrl: item.ticketUrl ?? null,
    })),
    ...followUpLoopBudget(state),
  }
}

/**
 * Whether a step's follow-up companion is asking anything. Narrower than the other predicates
 * here, and for the opposite reason: this park accrues LIVE, so the items exist long before the
 * run stops and long after it moves on. Only a `pending` item is a question; the rest are the
 * caller's own decisions, projected so it can see them, not asked again.
 */
function isLiveFollowUps(state: FollowUpsStepState): boolean {
  return state.enabled && state.items.some((item) => item.status === 'pending')
}

/** Project a parked INTERVIEW gate: which interviewer is asking, and the exchanges so far. */
function toInterviewDecision(
  stepKind: string,
  blockId: string,
  view: InterviewView,
): PublicDecision {
  return {
    kind: 'interview',
    stepKind,
    taskId: blockId,
    round: view.round,
    maxRounds: view.maxRounds,
    questions: view.questions.map((q) => ({
      questionId: q.id,
      question: q.question,
      answer: q.answer,
      status: q.status,
    })),
  }
}

/**
 * Project the PRE-DISPATCH INPUT GATE's verdict for an external caller. The issue CODES are the same
 * closed vocabulary the SPA renders, so an integration maps them to its own copy (or hands them to
 * whoever filed the ticket) rather than parsing our prose.
 */
function toInputGateDecision(gate: RunInputGate): PublicDecision {
  return {
    kind: 'input-gate',
    status: gate.status,
    mode: gate.mode,
    issues: gate.issues,
    checkedAt: gate.checkedAt,
  }
}

/**
 * Whether the gate's verdict is something the caller still has to act on. ONLY `blocked`, which is
 * narrower than the other predicates here on purpose: `off`, `not_applicable` and `passed`
 * are recorded facts about a run that was never held up, and `overridden` is a park somebody
 * already answered. Listing any of them would put a decision in front of a caller with nothing to
 * decide, and `parked` is read off the run's own status rather than from this list, so a settled
 * verdict has nothing to add to it.
 */
function isLiveInputGate(gate: RunInputGate): boolean {
  return gate.status === 'blocked'
}

/**
 * Build the run's decision list: whatever it is currently asking a human, plus the run status so a
 * caller can distinguish "parked, answer me" from "still working".
 *
 * The run is RE-READ rather than taken from the `ScopedRun` the caller was gated with, because
 * every mutating route builds its response through here AFTER acting: a `proceed` that advanced the
 * run, or an `incorporate` that flipped it out of `blocked`, must not report the pre-action status.
 * A run that vanished between the gate and here (a concurrent delete) falls back to the gated
 * snapshot rather than 500-ing on an action that already succeeded.
 *
 * Everything that rides the run's STEPS is read off the instance already in hand; only the
 * separately-stored iterative reviews cost a round-trip, and those are bounded by what the run's
 * own step chain can produce (see {@link liveDialogueDecisions}).
 */
export async function buildDecisionList<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  scoped: ScopedRun,
): Promise<PublicDecisionList> {
  const container = c.get('container')
  const execution =
    (await container.executionRepository.get(workspaceId, scoped.execution.id)) ?? scoped.execution

  // The dialogue reads and the fork read are INDEPENDENT point lookups in separate stores, so they
  // are issued together: this projection is on the poll path AND rebuilt after every answer, and
  // awaiting them in sequence made its latency the sum of every park kind a run could carry rather
  // than the slowest one. The concatenation order below is still deterministic.
  const [dialogue, fork, interview] = await Promise.all([
    liveDialogueDecisions(c, workspaceId, scoped.blockId, execution),
    liveForkDecisions(c, workspaceId, execution),
    liveInterviewDecisions(c, workspaceId, scoped.blockId, execution),
  ])
  const decisions: PublicDecision[] = [
    ...dialogue,
    ...fork,
    ...interview.decisions,
    // Step-anchored decisions LAST, and `answeredStepIndexes` reads the assembled list below, so
    // an approval raised by an exhausted gate is in hand before the wait report is built.
    ...liveStepDecisions(execution, container.agentKindRegistry),
  ]

  // The input gate parks BEFORE the first dispatch, so when it is live it is the only thing the
  // run is asking. Listed first for that reason: it is the earliest question, and the steps whose
  // decisions follow have not run.
  if (execution.inputGate && isLiveInputGate(execution.inputGate)) {
    decisions.unshift(toInputGateDecision(execution.inputGate))
  }

  return {
    runId: execution.id,
    taskId: scoped.blockId,
    status: execution.status,
    // `blocked` IS the parked state — the run is waiting on a human and will not move until one
    // of these decisions is answered. Read from the run itself rather than inferred from the
    // decisions, so a run parked on a surface this projection doesn't model still reports
    // `parked: true` with an empty list rather than silently claiming all is well.
    parked: execution.status === 'blocked',
    decisions,
    // …and `unanswerable` is what stops that empty list being a riddle: it NAMES the wait. Handed
    // the decisions it sits beside, so a wait this very response answers cannot also be reported
    // as one nobody here can.
    unanswerable: unanswerableWaits(
      execution,
      container.gateRegistry,
      interview.unwiredGate,
      answeredStepIndexes(decisions),
    ),
  }
}

/**
 * A parked interview gate this deployment registered as an agent kind but wired no controller for,
 * carried out of {@link liveInterviewDecisions} with the step it was found on.
 */
export interface UnwiredInterviewGate {
  stepKind: string
  stepIndex: number
}

/**
 * The step indexes this response ALREADY offers a decision for.
 *
 * Derived from the assembled list rather than re-deduced from the steps, which makes "a wait we
 * name is never a wait we answer" structural instead of a rule two functions have to keep
 * agreeing about: a decision kind that starts carrying a `stepIndex` joins this automatically.
 *
 * The case that made it necessary: a gate the deployment registered spends its attempt budget,
 * `onExhausted` raises an ordinary step approval, and that approval IS answerable here — while the
 * step still carries its gate state, which read on its own says "waiting on a person, wherever
 * that deployment put the answer". Both are in the same payload, and only one of them is true.
 */
function answeredStepIndexes(decisions: readonly PublicDecision[]): ReadonlySet<number> {
  return new Set(
    decisions.flatMap((decision) => ('stepIndex' in decision ? [decision.stepIndex] : [])),
  )
}

/**
 * Every wait holding this run that the decision surface cannot answer, named.
 *
 * Read entirely off the instance already in hand, because each cause is visible in the step chain:
 * a live GATE step is one whose `gate` state exists and whose step is not done, and an unwired
 * interviewer is what {@link liveInterviewDecisions} already resolved and found no controller for.
 *
 * A gate is classified from its OWN registration, which is where `pollExhaustion` is declared:
 * `rearm` is a poll with no deadline, which is the engine's way of saying a person is the gate.
 * Anything else is BOUNDED and deliberately absent: `ci` looping through a fixer is the gate doing
 * its job, and listing it would read as a demand for a human nobody has to meet. Shipped and
 * deployment-registered gates go through the one rule, where this used to name the built-ins from a
 * hand-kept constant and report every gate a deployment registered as unclassifiable.
 *
 * `unclassified_gate` survives that change with a NARROWER meaning, and it is still reachable: a
 * step whose kind this process has no gate registration for at all. A run outlives a registration
 * (a deployment retires a gate, or a node one build behind serves a run started by one that is
 * not), and a kind nothing registers is the one case where the honest answer is still "this
 * deployment cannot say whether that poll ever ends".
 *
 * Two exclusions keep the list to waits that are actually holding the run, and each was a way for
 * the field to state the opposite of the truth it exists to state:
 *
 *  - **A FINISHED run holds nothing.** `failRun` records the failure and stops; it does not walk
 *    the chain settling steps, so a stopped or failed run keeps its in-flight gate step exactly as
 *    it stood. Reading the steps alone would answer a caller who has already cancelled with "a
 *    reviewer must approve the pull request; stop the run instead".
 *  - **A wait the caller was just handed an answer for** ({@link answeredStepIndexes}).
 */
export function unanswerableWaits(
  execution: Pick<ExecutionInstance, 'status' | 'steps'>,
  /** The app-owned gate registry: the authority for what a spent poll budget means per kind. */
  gates: GateRegistry,
  unwiredGate: UnwiredInterviewGate | null,
  /**
   * Required rather than defaulted, because it is half of the question: "unanswerable" is a claim
   * ABOUT the decisions this response carries, and a caller who omitted the set would get the
   * double-report back with nothing failing.
   */
  answered: ReadonlySet<number>,
): PublicUnanswerableWait[] {
  if (execution.status === 'done' || execution.status === 'failed') return []
  const waits: PublicUnanswerableWait[] = []
  execution.steps.forEach((step, stepIndex) => {
    if (!step.gate || step.state === 'done' || answered.has(stepIndex)) return
    const pollExhaustion = gates.pollExhaustion(step.agentKind)
    if (pollExhaustion === 'rearm') {
      waits.push({
        reason: 'human_wait_gate',
        stepKind: step.agentKind,
        stepIndex,
        detail:
          `The run is waiting on the '${step.agentKind}' gate, which has no deadline because a ` +
          'person is the gate. It clears when a reviewer approves the pull request on the VCS ' +
          'host; there is no API call that answers it. Use POST /api/v1/tasks/:taskId/stop to ' +
          'abandon the run instead.',
      })
      return
    }
    if (pollExhaustion === undefined) {
      waits.push({
        reason: 'unclassified_gate',
        stepKind: step.agentKind,
        stepIndex,
        detail:
          `The run is on the '${step.agentKind}' gate, which this deployment has no registration ` +
          'for. Whether its poll ever ends was declared wherever the gate used to be registered ' +
          'and cannot be read here, so it may be waiting on a person indefinitely. Its answer ' +
          'lives wherever the deployment surfaced it.',
      })
    }
  })
  // The interviewer arrives with its own index (`findParkedInterviewStep` resolved the STEP, not
  // just its kind) rather than being re-found by kind here: a chain carrying the same interviewer
  // twice would otherwise report the first one's position for the second one's park, and
  // `stepIndex` exists precisely to be lined up against `publicRun.steps`.
  if (unwiredGate) {
    waits.push({
      reason: 'unwired_interview_gate',
      stepKind: unwiredGate.stepKind,
      stepIndex: unwiredGate.stepIndex,
      detail:
        `The run is parked on the '${unwiredGate.stepKind}' interview gate, which this deployment ` +
        'registered as an agent kind but wired no controller for. Its questions are readable ' +
        'from no surface, here or in the app, until the deployment wires it.',
    })
  }
  return waits
}

/**
 * The block-scoped iterative reviews a run can be parked on: requirements, clarity, and a
 * brainstorm session per stage.
 *
 * Each of these lives in its OWN store, so each is a point read. Clarity and the brainstorms are
 * fetched only when the run's step chain actually carries the kind that creates them: a run with
 * no `clarity-review` step cannot be parked on a clarity review, and paying for the read on every
 * poll of every run would make the cost of this endpoint a function of how many park kinds exist
 * rather than of what the run can ask.
 *
 * Requirements is deliberately NOT step-gated. It has been read unconditionally since this surface
 * shipped, which also serves a review run off-path from the block inspector; narrowing it now
 * would take capability away from a live integration, and `/api/v1` does not do that.
 */
async function liveDialogueDecisions<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  blockId: string,
  execution: ExecutionInstance,
): Promise<PublicDecision[]> {
  const container = c.get('container')
  const kinds = new Set(execution.steps.map((s) => s.agentKind))
  const { requirements, clarity, brainstorm } = container

  // Each read is against a different store with nothing to say to the others, so they are issued
  // together rather than chained. The RESULT order is fixed by the tuple, not by which store
  // answered first, so a caller's decision list does not reshuffle between two polls of one run.
  const [requirementsReview, clarityReview, brainstormSessions] = await Promise.all([
    requirements ? requirements.service.getForBlock(workspaceId, blockId) : null,
    clarity && kinds.has(CLARITY_REVIEW_AGENT_KIND)
      ? clarity.service.getForBlock(workspaceId, blockId)
      : null,
    brainstorm
      ? Promise.all(
          liveBrainstormStages(kinds).map((stage) =>
            brainstorm.services[stage].getForBlock(workspaceId, blockId),
          ),
        )
      : [],
  ])

  const decisions: PublicDecision[] = []
  if (requirementsReview && isLiveReview(requirementsReview)) {
    decisions.push(toRequirementsDecision(requirementsReview))
  }
  if (clarityReview && isLiveReview(clarityReview)) {
    decisions.push(toClarityDecision(clarityReview))
  }
  for (const session of brainstormSessions) {
    if (session && isLiveReview(session)) decisions.push(toBrainstormDecision(session))
  }
  return decisions
}

/**
 * The brainstorm stages this run's step chain can park on. A block may hold one live session per
 * stage at once, so this returns a LIST: a pipeline running both dialogues puts two brainstorm
 * decisions in front of the caller, and collapsing them to one would hide whichever came second.
 */
function liveBrainstormStages(kinds: Set<string>): BrainstormStage[] {
  const stages: BrainstormStage[] = []
  if (kinds.has(REQUIREMENTS_BRAINSTORM_AGENT_KIND)) stages.push('requirements')
  if (kinds.has(ARCHITECTURE_BRAINSTORM_AGENT_KIND)) stages.push('architecture')
  return stages
}

/**
 * The run's INTERVIEW park, if it has one. The questions live on the gate's own entity (an
 * initiative row, a document-interview session) rather than on the step, so this costs a read,
 * gated on the run actually being PARKED on an interview step, which is stricter than the
 * step-chain gating the dialogue reads use and can be, because there is no off-path interview to
 * serve: an interview exists only while its gate holds the run.
 *
 * A parked step whose gate this deployment never wired resolves to no controller and yields no
 * decision, which is the truth — but it is REPORTED rather than dropped, as the {@link
 * UnwiredInterviewGate} this returns beside the decisions. Registered-but-unwired is a real state
 * (admission counts the kind's trait, answering needs the controller as well), and a run stopped
 * there used to be indistinguishable from one stopped for no visible reason at all. The routes
 * still answer such a caller with a 503 naming the interviewer, rather than this projection
 * inventing a decision.
 */
async function liveInterviewDecisions<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  blockId: string,
  execution: ExecutionInstance,
): Promise<{ decisions: PublicDecision[]; unwiredGate: UnwiredInterviewGate | null }> {
  const container = c.get('container')
  const parked = findParkedInterviewStep(execution, container.agentKindRegistry)
  if (!parked) return { decisions: [], unwiredGate: null }
  const gate = container.executionService.interviewGateFor(parked.step.agentKind)
  // The STEP, not just its kind: `findParkedInterviewStep` resolved which step is holding the run,
  // and throwing its index away here is what would force the reporting side to guess it back.
  if (!gate) {
    return {
      decisions: [],
      unwiredGate: { stepKind: parked.step.agentKind, stepIndex: parked.index },
    }
  }
  const view = await gate.getView(workspaceId, blockId)
  return {
    decisions:
      view && view.status === 'awaiting'
        ? [toInterviewDecision(parked.step.agentKind, blockId, view)]
        : [],
    unwiredGate: null,
  }
}

/** The run's implementation-fork park, which the engine stores behind its own service read. */
async function liveForkDecisions<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  execution: ExecutionInstance,
): Promise<PublicDecision[]> {
  const fork = await c
    .get('container')
    .executionService.decisions.getForkDecision(workspaceId, execution.id)
  return fork && isLiveFork(fork) ? [toForkDecision(fork)] : []
}

/**
 * Every park that rides the run's own STEPS — no repository round-trip, since all of this state
 * lives on the instance already in hand (the whole reason none of it has a side table).
 *
 * Scanned over the WHOLE step chain rather than `currentStep` alone: the engine parks a run by
 * leaving the step waiting, and which index that is depends on the park (a companion gate sits on
 * the companion's step, an approval gate on the producer's), so keying off the cursor would report
 * an empty list for a run that is plainly stopped.
 */
function liveStepDecisions(
  execution: ExecutionInstance,
  registry: AgentKindRegistry,
): PublicDecision[] {
  const decisions: PublicDecision[] = []
  execution.steps.forEach((step, index) => {
    const approval = step.approval
    if (approval?.status === 'pending' && isGenericApprovalPark(execution, step, registry)) {
      decisions.push(toApprovalDecision(step, index, approval))
    }
    if (step.decision && step.decision.chosen == null) {
      decisions.push(toAgentDecision(step, step.decision))
    }
    if (step.judge && isLiveJudge(step.judge)) {
      decisions.push(toJudgeDecision(step.agentKind, step.judge))
    }
    if (step.prReview && isLivePrReview(step.prReview)) {
      decisions.push(toPrReviewDecision(step.prReview))
    }
    if (step.humanTest && isLiveHumanTest(step.humanTest)) {
      decisions.push(toHumanTestDecision(step.humanTest))
    }
    if (step.visualConfirm && isLiveVisualConfirm(step.visualConfirm)) {
      decisions.push(toVisualConfirmDecision(step.visualConfirm))
    }
    if (step.followUps && isLiveFollowUps(step.followUps)) {
      decisions.push(toFollowUpsDecision(step, index, step.followUps))
    }
  })
  return decisions
}

/**
 * Whether a step's pending approval is an ORDINARY approval gate — the one the approve /
 * request-changes / reject routes answer.
 *
 * `step.approval` is the engine's generic parking mechanism, so a review gate, a brainstorm, a
 * human-verdict gate and a fork choice all carry a pending approval too. Reporting those as
 * `approval-gate` would be the worst kind of wrong here: the caller would be offered verbs the
 * engine refuses (`assertNotIterativeGate`), so a well-behaved integration would sit in a 409 loop
 * against a park it was told it could answer. The classifier is the ENGINE's own, so what this
 * surface offers and what the engine accepts cannot disagree.
 *
 * `companion-cap` is admitted rather than excluded: it IS answered here, by `resolve-exceeded`,
 * and the projection flags it as `exceeded` so a caller reaches for that verb instead of approve.
 */
function isGenericApprovalPark(
  execution: ExecutionInstance,
  step: PipelineStep,
  registry: AgentKindRegistry,
): boolean {
  const surface = dedicatedParkSurface(execution, step, registry)
  return surface === null || surface === 'companion-cap'
}
