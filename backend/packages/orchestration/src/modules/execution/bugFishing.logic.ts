import {
  BUG_FISHING_PHASES,
  BUG_FISHING_SEVERITY_ORDER,
  type BugFishingAgentOutput,
  type BugFishingFinding,
  type BugFishingPhase,
  type BugFishingSpawn,
  type BugFishingStepState,
  bugFishingSpawnIsClaimable,
  describeBugFishingPhase,
  redactSecrets,
} from '@cat-factory/kernel'

// The one rule both this engine and the triage window judge a finding by ("is anything being
// done about it") lives in contracts, so the window cannot come to offer a mark this refuses.
// Re-exported so a caller in this module's own layer keeps one import.
export { BUG_FISHING_SPAWN_CLAIM_TTL_MS, bugFishingSpawnIsClaimable } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure reductions over a bug-fishing expedition's step state. Everything here is a
// total function of (state, input) → state so the controller's CAS bodies stay pure
// and every rule is unit-testable without a run: which angles an expedition plans,
// how one pass's raw output becomes stamped findings, and what marking or dismissing
// a finding does to the record.
//
// The mirror of `prReview.logic.ts` for the expedition flow.
// ---------------------------------------------------------------------------

/** Cap on a single finding's free-text field, so one runaway reply cannot bloat the run blob. */
const MAX_FINDING_TEXT = 4000
/** Cap on a phase summary. */
const MAX_SUMMARY = 4000
/**
 * Most findings one pass may contribute.
 *
 * The state rides the run's persisted `detail` blob, re-serialized on every progress write, and
 * an expedition runs eight passes over it. The cap is generous enough that hitting it means the
 * pass stopped applying the finding bar, which is why the overflow is REPORTED in the phase
 * summary rather than silently trimmed: a reader who assumed a prefix would conclude the tail
 * was never found.
 */
const MAX_FINDINGS_PER_PHASE = 40

/**
 * Trim, SCRUB and cap one field of a finding, in that order.
 *
 * Scrubbing at the mint site rather than at each reader, and BEFORE the cap, for the reason the
 * PR-report composer states: a finding's `evidence` is code the agent quoted out of the
 * repository, so a checked-in credential reaches it the same way it reaches any captured output.
 * From here it lands in the expedition record, in the triage window, in an inbox card, and in the
 * DESCRIPTION of every spawned fix task — four surfaces, only one of which would be an obvious
 * place to remember. Scrubbing before the cap keeps a redacted span from being split in half by
 * it, which would put the tail of a secret back in the text.
 */
function clamp(text: string | undefined | null, max: number): string {
  const t = redactSecrets((text ?? '').trim()) ?? ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function optionalClamped(text: string | undefined | null, max: number): string | undefined {
  const t = clamp(text, max)
  return t.length > 0 ? t : undefined
}

/**
 * Plan the angles an expedition will fish.
 *
 * `selected` is the creator's pick, held as bare strings (a task authored against a later
 * build's angle list must still parse here). An id this build does not ship is DROPPED and
 * returned in `unknown`, so the caller can say so in the plan rather than silently fishing
 * fewer angles than the person asked for. An empty or entirely-unrecognised selection falls
 * back to the whole catalog, which is the intended default: an expedition exists to cover
 * ground nobody thought to look at, so narrowing it is the deliberate act.
 *
 * Order follows the CATALOG rather than the selection, so two expeditions on the same board
 * fish their shared angles in the same order and their phase lists read alike.
 */
export function planBugFishingPhases(selected: readonly string[] | undefined): {
  phases: BugFishingPhase[]
  unknown: string[]
} {
  const picked = new Set((selected ?? []).map((id) => id.trim()).filter((id) => id.length > 0))
  const unknown = [...picked].filter((id) => !BUG_FISHING_PHASES.some((p) => p.id === id))
  const chosen = BUG_FISHING_PHASES.filter((p) => picked.size === 0 || picked.has(p.id))
  const catalog = chosen.length > 0 ? chosen : BUG_FISHING_PHASES
  return {
    phases: catalog.map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      status: 'pending' as const,
      summary: null,
      settledAt: null,
      failureReason: null,
    })),
    unknown,
  }
}

/** Severity rank, most severe first; an unrecognised severity sorts last rather than first. */
function severityRank(severity: string): number {
  const index = BUG_FISHING_SEVERITY_ORDER.indexOf(severity as never)
  return index === -1 ? BUG_FISHING_SEVERITY_ORDER.length : index
}

/**
 * Turn ONE pass's raw output into stamped, severity-ordered findings.
 *
 * A finding with neither a title nor a detail is dropped: the lenient agent schema fills both
 * with `''` rather than failing the parse, so an entry carrying neither is an artefact of that
 * leniency and not something a human could triage. Everything else is kept, including a finding
 * with no path — an expedition can legitimately report a gap that spans files, and blanking the
 * row would be the platform deciding it did not happen.
 */
export function coerceBugFishingFindings(
  output: BugFishingAgentOutput | undefined,
  phaseId: string,
  mintId: () => string,
): { findings: BugFishingFinding[]; dropped: number } {
  const raw = (output?.findings ?? []).filter(
    (f) =>
      clamp(f.title, MAX_FINDING_TEXT).length > 0 || clamp(f.detail, MAX_FINDING_TEXT).length > 0,
  )
  const kept = [...raw].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const dropped = Math.max(0, kept.length - MAX_FINDINGS_PER_PHASE)
  return {
    findings: kept.slice(0, MAX_FINDINGS_PER_PHASE).map((f) => ({
      id: mintId(),
      phaseId,
      path: clamp(f.path, 400),
      line: typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : null,
      severity: f.severity,
      kind: f.kind,
      confidence: f.confidence,
      title: clamp(f.title, 300) || clamp(f.detail, 300),
      detail: clamp(f.detail, MAX_FINDING_TEXT),
      failureScenario: optionalClamped(f.failureScenario, MAX_FINDING_TEXT) ?? null,
      evidence: optionalClamped(f.evidence, MAX_FINDING_TEXT) ?? null,
      suggestedFix: optionalClamped(f.suggestedFix, MAX_FINDING_TEXT) ?? null,
      spawn: null,
      dismissed: false,
    })),
    dropped,
  }
}

/**
 * Record a COMPLETED pass: settle its phase with the summary it gave, append its findings, and
 * move the cursor to the next angle.
 *
 * The returned status is `fishing` while an angle is still pending and `awaiting_triage` once
 * the last one settles — the state's own answer to "is there more coming", which the window
 * renders and the controller uses to decide between re-arming the step and parking the run.
 */
export function recordBugFishingPhase(
  state: BugFishingStepState,
  phaseIndex: number,
  outcome: { summary: string | null; findings: BugFishingFinding[]; dropped: number; at: number },
): BugFishingStepState {
  const phases = (state.phases ?? []).map((phase, i) =>
    i === phaseIndex
      ? {
          ...phase,
          status: 'completed' as const,
          summary: phaseSummary(outcome.summary, outcome.findings.length, outcome.dropped),
          settledAt: outcome.at,
          failureReason: null,
        }
      : phase,
  )
  const next = phaseIndex + 1
  return {
    ...state,
    phases,
    currentPhaseIndex: next,
    findings: [...(state.findings ?? []), ...outcome.findings],
    status: next < phases.length ? 'fishing' : 'awaiting_triage',
  }
}

/**
 * The phase summary as recorded: the agent's own account, plus a sentence naming any findings
 * the per-phase cap dropped.
 *
 * A cap that is not a plain prefix has to say so — a reader who assumed one would conclude the
 * tail was never found, when in fact it was found and discarded.
 */
function phaseSummary(summary: string | null, kept: number, dropped: number): string {
  const base = clamp(summary, MAX_SUMMARY)
  if (dropped <= 0) return base
  const note =
    `This pass reported more findings than one phase may record: the ${kept} most severe were ` +
    `kept and ${dropped} lower-severity ones were dropped. Re-run this angle with a narrower ` +
    'focus to see them.'
  return base ? `${base}\n\n${note}` : note
}

/**
 * Record a pass that FAILED (its container job crashed, or produced nothing usable). The phase
 * is settled as `failed` carrying the reason and the expedition moves on to the next angle.
 *
 * One angle failing must never cost the expedition the angles that already landed, nor the ones
 * still to come: the passes are independent by construction, which is the point of running them
 * as separate dispatches. The failure is NAMED on the phase rather than dropped, because a phase
 * that silently reported nothing reads exactly like a phase that found nothing.
 */
export function failBugFishingPhase(
  state: BugFishingStepState,
  phaseIndex: number,
  reason: string | null,
  at: number,
): BugFishingStepState {
  const phases = (state.phases ?? []).map((phase, i) =>
    i === phaseIndex
      ? {
          ...phase,
          status: 'failed' as const,
          settledAt: at,
          failureReason: clamp(reason, 2000) || 'The pass did not complete.',
        }
      : phase,
  )
  const next = phaseIndex + 1
  return {
    ...state,
    phases,
    currentPhaseIndex: next,
    status: next < phases.length ? 'fishing' : 'awaiting_triage',
  }
}

/** Mark the phase at `phaseIndex` as being fished right now (the dispatch just went out). */
export function startBugFishingPhase(
  state: BugFishingStepState,
  phaseIndex: number,
): BugFishingStepState {
  return {
    ...state,
    currentPhaseIndex: phaseIndex,
    phases: (state.phases ?? []).map((phase, i) =>
      i === phaseIndex ? { ...phase, status: 'fishing' as const } : phase,
    ),
  }
}

/**
 * CLAIM a finding for a spawn, BEFORE the task it names is created.
 *
 * The claim is what makes marking safe against two callers at once: it is written under the
 * run's compare-and-swap, so exactly one of them lands and the loser's transform is a no-op on
 * a finding that is no longer claimable. The claimer recognises its own by the `taskId` it minted
 * and put in the claim, exactly as the initiative loop recognises its own spawn by block id —
 * which is what lets {@link settleBugFishingSpawn} refuse to overwrite a claim it does not own.
 *
 * A no-op on an unknown, dismissed or already-claimed finding. The caller re-reads the finding
 * afterwards and compares the `taskId`: that comparison, not this function, is how it learns
 * whether it won.
 */
export function claimBugFishingSpawn(
  state: BugFishingStepState,
  findingId: string,
  claim: BugFishingSpawn,
  now: number,
): BugFishingStepState {
  return {
    ...state,
    findings: (state.findings ?? []).map((f) =>
      f.id === findingId && !f.dismissed && bugFishingSpawnIsClaimable(f.spawn, now)
        ? { ...f, spawn: claim }
        : f,
    ),
  }
}

/**
 * SETTLE a claim this caller owns: `spawned` once the task and its run exist, or `failed` with
 * the cause when they do not.
 *
 * Matched on `taskId`, so a claim that expired and was re-taken by somebody else is left alone.
 * Overwriting it would report the loser's outcome against the winner's task.
 */
export function settleBugFishingSpawn(
  state: BugFishingStepState,
  findingId: string,
  taskId: string,
  outcome:
    | { status: 'spawned'; executionId: string | null }
    | { status: 'failed'; failureReason: string },
): BugFishingStepState {
  return {
    ...state,
    findings: (state.findings ?? []).map((f) =>
      f.id === findingId && f.spawn?.taskId === taskId
        ? { ...f, spawn: { ...f.spawn, ...outcome } }
        : f,
    ),
  }
}

/**
 * Dismiss a finding: it stays on the record, struck through, and can no longer be marked.
 *
 * Kept rather than removed because the expedition's record is what a human reads to decide
 * whether the hunt was worth running: a finding that was looked at and rejected is evidence
 * about the agent's precision, and deleting it would make every expedition look flawless.
 * Idempotent, and a no-op on a finding whose fix task exists or is being created (that decision
 * is made). A finding whose last mark FAILED is dismissable: nothing was created for it.
 */
export function dismissBugFishingFinding(
  state: BugFishingStepState,
  findingId: string,
  now: number,
): BugFishingStepState {
  return {
    ...state,
    findings: (state.findings ?? []).map((f) =>
      f.id === findingId && bugFishingSpawnIsClaimable(f.spawn, now)
        ? { ...f, dismissed: true }
        : f,
    ),
  }
}

/**
 * Findings with no decision yet: neither dismissed nor carrying a mark that landed.
 *
 * A `failed` spawn counts as UNTRIAGED, because it is: the human made a decision, the platform
 * did not carry it out, and nothing was created. Counting it as done is how "N findings to
 * triage" would come to under-report the work left, on exactly the runs where something went
 * wrong.
 */
export function untriagedBugFishingFindings(
  state: BugFishingStepState,
  now: number,
): readonly BugFishingFinding[] {
  return (state.findings ?? []).filter(
    (f) => !f.dismissed && bugFishingSpawnIsClaimable(f.spawn, now),
  )
}

/**
 * The finding titles to brief the NEXT pass with, so it does not re-report what earlier angles
 * already caught. Dismissed findings are included deliberately: a human rejecting a finding says
 * they do not want it fixed, not that the next pass should raise it again.
 */
export function priorBugFishingFindingTitles(state: BugFishingStepState): string[] {
  return (state.findings ?? []).map((f) => f.title).filter((t) => t.trim().length > 0)
}

/**
 * The angle a phase index names, described from the CATALOG but falling back to what the run
 * itself recorded.
 *
 * Two different absences, and they need different answers. A phase whose id this build retired
 * is described by {@link describeBugFishingPhase} as retired, but the run still knows the title
 * and goal it was planned under, so those win over the placeholder — the expedition genuinely
 * fished that angle and its own record is the better witness. Only an id with no recorded phase
 * at all falls through to the placeholder.
 */
export function describeRecordedPhase(phase: BugFishingPhase) {
  const described = describeBugFishingPhase(phase.id)
  return {
    ...described,
    title: phase.title || described.title,
    goal: phase.goal || described.goal,
  }
}
