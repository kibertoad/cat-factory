import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The PRE-DISPATCH INPUT GATE's wire vocabulary: what a run's structural input check
// found, how severe it is, and how the run was let past it.
//
// The gate is a deterministic reduction over a task's own authored fields (title,
// description, the per-type fields), run ONCE before a run's first agent step is
// dispatched, so a task nobody could act on parks having spent nothing, rather than
// buying that same verdict from the requirements reviewer for one model call.
//
// It lives in contracts (not only in kernel) because the SPA renders each finding and
// must key its translated copy off the SAME closed vocabulary the engine writes. Pure
// evaluation is kernel's `domain/input-gate.ts`; the run state is stamped by the
// orchestration `InputGateController`.
// ---------------------------------------------------------------------------

/**
 * A structural gap the gate can find in a task's input. CLOSED and PERSISTED (it rides a
 * run row), so a member may be added freely but a retired one has to be NAMED as retired
 * rather than dropped. A stored run keeps whatever code was current when it parked, and
 * the reader that meets a withdrawn value is the very surface whose job is to tell a human
 * what to go and fix.
 *
 * - `description_missing`: the task has no description at all.
 * - `description_placeholder`: the description is nothing but a placeholder (`TBD`, `TODO`,
 *   `n/a`, `?`), authored but carrying no statement of the work.
 * - `description_thin`: a description too short to specify anything (advisory: a one-line
 *   task can still be a real task).
 * - `reproduction_missing`: a `bug` task with neither reproduction steps nor any
 *   reproduction cue in its description. The single most expensive input gap there is: a
 *   fixer with nothing to reproduce cannot know when it is done.
 * - `review_target_missing`: a `review` task naming no pull request. There is literally
 *   nothing for the run to open.
 * - `success_criteria_missing`: a `spike` with no stated success criteria or research
 *   question, so nothing decides when the timebox has been spent well (advisory).
 */
export const INPUT_GATE_ISSUE_CODES = [
  'description_missing',
  'description_placeholder',
  'description_thin',
  'reproduction_missing',
  'review_target_missing',
  'success_criteria_missing',
] as const
export const inputGateIssueCodeSchema = v.picklist(INPUT_GATE_ISSUE_CODES)
export type InputGateIssueCode = v.InferOutput<typeof inputGateIssueCodeSchema>

/**
 * How hard a finding bites. `blocking` parks the run before its first dispatch;
 * `advisory` is recorded and reported but never stops anything.
 *
 * A finding's severity is INTRINSIC to its code (see kernel's `INPUT_GATE_SEVERITY`) and
 * then floored by the workspace's {@link inputGateModeSchema}. `advisory` mode downgrades
 * every finding; it never upgrades one. So the mode can only ever make the gate quieter,
 * which is what lets it default to on.
 */
export const inputGateSeveritySchema = v.picklist(['blocking', 'advisory'])
export type InputGateSeverity = v.InferOutput<typeof inputGateSeveritySchema>

/** One structural finding: its code and the severity it carried in THIS evaluation. */
export const inputGateIssueSchema = v.object({
  code: inputGateIssueCodeSchema,
  severity: inputGateSeveritySchema,
})
export type InputGateIssue = v.InferOutput<typeof inputGateIssueSchema>

/**
 * Whether/how the gate applies to a workspace's runs:
 *  - `standard` (the default): a blocking finding parks the run before any model call.
 *  - `advisory`: every finding is downgraded, so nothing ever parks; the findings are
 *    still recorded on the run (and shown), which is how a workspace watches what the gate
 *    WOULD have caught before turning it up.
 *  - `off`: the gate does not run. Distinct from `advisory`: `off` records no
 *    findings at all, so "we looked and found nothing" and "nobody looked" stay apart.
 */
export const inputGateModeSchema = v.picklist(['standard', 'advisory', 'off'])
export type InputGateMode = v.InferOutput<typeof inputGateModeSchema>

/**
 * The gate's disposition for a run. Five values because each needs a different reaction and
 * collapsing any pair would state something false:
 *  - `off`: the workspace has the gate turned off, so it did not run. NOT the same as
 *    finding nothing.
 *  - `not_applicable`: the gate is on, but this run's task is not one a human AUTHORED, so
 *    there is no description for it to judge. A recurring schedule's reused block is the
 *    case: its real input is the schedule (and, for intake, the ticket it picks up), and a
 *    blank description on it means nothing is wrong. Kept apart from `off` because the two
 *    have opposite fixes: one is a setting somebody chose, the other is a property of the
 *    task that no setting will change.
 *  - `passed`: it ran and nothing blocking was found (`issues` may still hold advisories).
 *  - `blocked`: it ran, found blocking gaps, and the run is parked on them.
 *  - `overridden`: a human read the blocking gaps and chose to run anyway. The findings
 *    stay on the run: what was waived is part of the record, and the agents are told.
 */
export const inputGateStatusSchema = v.picklist([
  'off',
  'not_applicable',
  'passed',
  'blocked',
  'overridden',
])
export type InputGateStatus = v.InferOutput<typeof inputGateStatusSchema>

/**
 * The gate's verdict as stamped on a run. Rides the run's `detail` JSON (no dedicated
 * column, so it is runtime-symmetric by construction) and is written exactly once per
 * evaluation. The presence of this record is also what makes the check idempotent under a
 * durable replay: a re-driven run reads its own settled verdict instead of re-evaluating a
 * block a human may have edited in the meantime.
 */
export const runInputGateSchema = v.object({
  /** The disposition (see {@link inputGateStatusSchema}). */
  status: inputGateStatusSchema,
  /** The mode the evaluation ran under, so a recorded verdict explains its own severities. */
  mode: inputGateModeSchema,
  /**
   * Every finding, blocking and advisory alike, in a stable order. Empty on `off` (nothing
   * was looked at) and on a clean `passed`.
   */
  issues: v.array(inputGateIssueSchema),
  /** Epoch ms of the evaluation that produced this verdict. */
  checkedAt: v.number(),
  /**
   * Internal user id (`usr_*`) of whoever waived the blocking findings, on `overridden`.
   * Absent when the run was never blocked, and when the waiver came from a caller with no
   * signed-in user (auth-disabled dev, a headless key).
   */
  overriddenBy: v.optional(v.nullable(v.string())),
  /** Epoch ms the override was recorded. Absent unless `status` is `overridden`. */
  overriddenAt: v.optional(v.number()),
})
export type RunInputGate = v.InferOutput<typeof runInputGateSchema>

/**
 * How a human resolves a run parked on the gate:
 *  - `recheck`: re-evaluate against the task as it stands NOW (they went and filled the
 *    gaps in). Clears the park only if the gaps are genuinely gone, so the fix is verified
 *    rather than asserted.
 *  - `proceed`: waive the findings and run anyway.
 */
export const resolveInputGateSchema = v.object({
  choice: v.picklist(['recheck', 'proceed']),
})
export type ResolveInputGateRequest = v.InferOutput<typeof resolveInputGateSchema>
export type ResolveInputGateChoice = ResolveInputGateRequest['choice']
