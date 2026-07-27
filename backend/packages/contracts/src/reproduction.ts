import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Bugfix REPRODUCTION PROOF.
//
// A bugfix run's pull request states that a change fixes a defect. Everything the
// verification report captures today proves the state of the work at the END — the CI
// verdict, the pre-PR validation output, the tester report. None of it shows that the
// defect ever manifested, or that this change is what made it stop.
//
// This is the missing half: the executor-harness runs the run's DECLARED reproduction
// command twice — once against the pre-fix tree, once against the final tree — and reports
// the two exit codes with their captured output. Only red-then-green is proof. The verdict
// is computed by the harness from exit codes, never self-reported by the model, which is the
// whole point (the `repro-test` kind's `outcome` field has always been the model's own claim).
//
// A run for which reproduction is genuinely infeasible declares that STRUCTURALLY, with a
// reason and the alternative verification performed, so "could not be reproduced" is never
// indistinguishable from "nobody tried".
//
// The spec travels to the container IN THE JOB BODY (containers have no DB access), so all
// three transports work with no transport-specific wiring. See
// docs/initiatives/bugfix-reproduction-proof.md.
// ---------------------------------------------------------------------------

/** The per-task tri-state that opts a run into the proof phase (an `agentConfig` value). */
export const reproductionProofModeSchema = v.picklist(['auto', 'always', 'off'])
export type ReproductionProofMode = v.InferOutput<typeof reproductionProofModeSchema>

/**
 * How many agent+verify rounds the proof loop may run before it gives up and records
 * `inconclusive`. Shares the pre-PR validation budget's shape and default so an operator meets
 * one concept, not two.
 */
export const REPRODUCTION_DEFAULT_MAX_ATTEMPTS = 3
export const REPRODUCTION_MAX_ATTEMPTS_CEILING = 10

/** At most this many declared test paths — the loop applies them one by one, so the list stays short. */
export const REPRODUCTION_MAX_TEST_PATHS = 20

/**
 * The RESOLVED reproduction spec a dispatch carries: what to run and which files constitute the
 * reproduction. Folded onto the agent run context and forwarded on the coding job body ONLY for
 * the dispatch that opens the PR (the same rule as `validationChecks`). Absent ⇒ the run is not
 * opted in, or carries no declaration, so the harness runs its existing path unchanged.
 */
export const resolvedReproductionSchema = v.object({
  /**
   * The command that runs EXACTLY the declared reproduction test(s), as `sh -c` in the checkout.
   * Run identically against both trees — the symmetry is what stops an environment defect from
   * masquerading as a reproduction (see the initiative's D4).
   */
  command: v.string(),
  /**
   * The test file(s) that constitute the reproduction. Used to reconstruct the pre-fix tree when
   * the run did NOT resume a branch that already carries them: the declared paths are applied
   * onto the base worktree, never a whole-tree checkout (which would drag the fix across and
   * green the base).
   */
  testPaths: v.array(v.string()),
  /**
   * Optional command that makes a FRESH worktree runnable (a dependency install). Run in BOTH
   * worktrees or neither — an asymmetric setup is exactly how a false `reproduced` is produced.
   */
  setupCommand: v.optional(v.string()),
  /** Repair-round budget; see {@link REPRODUCTION_DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts: v.number(),
})
export type ResolvedReproduction = v.InferOutput<typeof resolvedReproductionSchema>

// ---- The harness-produced report ------------------------------------------

/**
 * The verdict, computed by the harness from the two exit codes:
 *
 * - `reproduced` — RED on the pre-fix tree, GREEN on the final tree. The only shape that is proof.
 * - `inconclusive` — any other shape (green at base ⇒ the test does not capture the defect;
 *   red at both ⇒ the fix does not resolve it, or the environment is broken). Recorded honestly
 *   rather than dressed up; it never fails the step (see the initiative's D6).
 * - `declared_infeasible` — the agent structurally declared reproduction impossible, with a
 *   reason and what it verified instead. Nothing was run.
 */
export const reproductionStatusSchema = v.picklist([
  'reproduced',
  'inconclusive',
  'declared_infeasible',
])
export type ReproductionStatus = v.InferOutput<typeof reproductionStatusSchema>

/** One tree's run of the reproduction command. */
export const reproductionPhaseOutcomeSchema = v.object({
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure, 130 on abort. */
  exitCode: v.fallback(v.number(), 1),
  passed: v.fallback(v.boolean(), false),
  /** Bounded, secret-scrubbed tail of the command's combined stdout+stderr. */
  outputTail: v.fallback(v.optional(v.string()), undefined),
  /** Wall-clock of the command, ms. */
  durationMs: v.fallback(v.optional(v.number()), undefined),
  /** Set when the command was killed by the per-command watchdog. */
  timedOut: v.fallback(v.optional(v.boolean()), undefined),
  /** Set when the phase's setup command failed, so the tree never ran the check meaningfully. */
  setupFailed: v.fallback(v.optional(v.boolean()), undefined),
})
export type ReproductionPhaseOutcome = v.InferOutput<typeof reproductionPhaseOutcomeSchema>

/**
 * The harness-computed reproduction report. Lenient throughout (`v.fallback`) so a
 * partially-malformed payload from an older harness image degrades to a sensible shape rather
 * than failing a run whose actual deliverable — the fix — is fine.
 */
export const reproductionReportSchema = v.object({
  status: v.fallback(reproductionStatusSchema, 'inconclusive'),
  /** The command that was run against both trees (empty for `declared_infeasible`). */
  command: v.fallback(v.string(), ''),
  testPaths: v.fallback(v.array(v.fallback(v.string(), '')), []),
  /** The pre-fix tree's run. Absent for `declared_infeasible`. */
  base: v.fallback(v.optional(reproductionPhaseOutcomeSchema), undefined),
  /** The final tree's run. Absent for `declared_infeasible`, or when the base run settled it. */
  final: v.fallback(v.optional(reproductionPhaseOutcomeSchema), undefined),
  /** How many agent+verify rounds ran (1 = settled on the first pass). */
  attempts: v.fallback(v.number(), 1),
  maxAttempts: v.fallback(v.number(), REPRODUCTION_DEFAULT_MAX_ATTEMPTS),
  /** For `declared_infeasible`: WHY the bug could not be reproduced, verbatim from the agent. */
  reason: v.fallback(v.optional(v.string()), undefined),
  /**
   * For `declared_infeasible`: what the agent verified INSTEAD, verbatim. This is the field that
   * makes an infeasibility declaration reviewable rather than an empty section.
   */
  alternativeVerification: v.fallback(v.optional(v.string()), undefined),
  /** For `inconclusive`: which shape was observed, in one line, for the report and the step card. */
  note: v.fallback(v.optional(v.string()), undefined),
  at: v.fallback(v.number(), 0),
})
export type ReproductionReport = v.InferOutput<typeof reproductionReportSchema>

/** Parse an untrusted reproduction report (a harness payload), or `null` when unusable. */
export function parseReproductionReport(input: unknown): ReproductionReport | null {
  const parsed = v.safeParse(reproductionReportSchema, input)
  return parsed.success ? parsed.output : null
}
