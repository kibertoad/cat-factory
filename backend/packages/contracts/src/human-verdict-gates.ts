import * as v from 'valibot'
import { environmentStatusSchema } from './environments.js'

// ---------------------------------------------------------------------------
// HUMAN-VERDICT gate step states: the parked state of the two gates whose verdict is a PERSON,
// not a provider probe — `human-test` (validate a live ephemeral environment) and
// `visual-confirmation` (review the UI tester's screenshots against the reference designs).
//
// They are grouped here, apart from the polling gates' `GateStepState` in `execution.ts`, because
// they share a shape the programmatic gates do not have: an append-only history of human-requested
// helper `rounds`, and a transient `pendingAction` the human sets while the step is parked, which
// the durable driver consumes on re-entry (the analogue of a requirements gate's
// `pendingIncorporation`). A third human-verdict gate belongs in this file, not in `execution.ts`.
// ---------------------------------------------------------------------------

export const humanTestEnvironmentSchema = v.object({
  /** The `environments` row id, so the window can fetch access creds / re-poll status. */
  id: v.string(),
  /** The provisioned public URL the human tests against (null while still provisioning). */
  url: v.nullable(v.string()),
  /** The environment lifecycle status; see {@link environmentStatusSchema}. */
  status: environmentStatusSchema,
  /** Epoch ms the environment expires (TTL), when known. */
  expiresAt: v.optional(v.nullable(v.number())),
})
export type HumanTestEnvironment = v.InferOutput<typeof humanTestEnvironmentSchema>

/**
 * One round of human-driven remediation on a `human-test` gate: the human wrote findings and
 * asked for a fix (helper `fixer`), or pulled main and hit a conflict (helper
 * `conflict-resolver`). Appended when the round opens and stamped with its outcome once the
 * helper job settles, so the window can show the full history of what was asked and how it ended.
 */
export const humanTestRoundSchema = v.object({
  /** The kind of round — a findings-driven fix or a pull-main-with-conflicts resolve. */
  kind: v.picklist(['fix', 'pull-main']),
  /** The human's findings prompt (fix), or a one-line note for the pull-main round. */
  findings: v.string(),
  /** The helper container kind this round dispatched (`fixer` / `conflict-resolver`). */
  helperKind: v.string(),
  /** The helper job's id while it ran, for cross-referencing the run timeline. */
  jobId: v.optional(v.nullable(v.string())),
  /** How the helper ended once its job settled. Absent while still in flight. */
  outcome: v.optional(v.nullable(v.picklist(['completed', 'failed']))),
  /** Epoch ms the round opened (the human clicked Request fix / Pull main). */
  at: v.number(),
})
export type HumanTestRound = v.InferOutput<typeof humanTestRoundSchema>

/**
 * State a `human-test` gate carries while it runs. Unlike a polling gate (`ci`/`conflicts`)
 * there is no programmatic verdict — the HUMAN is the verdict — so the step spins up an
 * ephemeral environment, parks for a person to validate it, and on demand dispatches the same
 * helpers the other gates use (the Tester's `fixer` for findings; the `conflict-resolver` for a
 * conflicting pull-main). Phases:
 *   - `provisioning`        — an environment is being stood up (the driver polls until ready).
 *   - `awaiting_human`      — parked: the human tests the env and confirms / requests a fix / etc.
 *   - `fixing`              — a `fixer` job (from the human's findings) is in flight.
 *   - `resolving_conflicts` — a `conflict-resolver` job (from a conflicting pull-main) is in flight.
 *   - `passed`             — the human confirmed; the env is torn down and the run advances.
 */
export const humanTestPhaseSchema = v.picklist([
  'provisioning',
  'awaiting_human',
  'fixing',
  'resolving_conflicts',
  'passed',
])
export type HumanTestPhase = v.InferOutput<typeof humanTestPhaseSchema>

export const humanTestStepStateSchema = v.object({
  phase: humanTestPhaseSchema,
  /** The live ephemeral environment (null in degraded manual mode / after destroy). */
  environment: v.optional(v.nullable(humanTestEnvironmentSchema)),
  /**
   * Why no environment was auto-provisioned — set in degraded manual mode (no env provider
   * wired, or provisioning errored) so the window can explain it and let the human test
   * against the PR branch manually. Absent when an env was provisioned.
   */
  degradedReason: v.optional(v.nullable(v.string())),
  /** How many helper (fixer / conflict-resolver) attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on helper attempts, resolved from the task's merge preset (`ciMaxAttempts`). */
  maxAttempts: v.number(),
  /** The PR head commit being tested, when known. */
  headSha: v.optional(v.nullable(v.string())),
  /** Append-only history of fix / pull-main rounds; see {@link humanTestRoundSchema}. */
  rounds: v.optional(v.array(humanTestRoundSchema)),
  /**
   * Transient action the human requested while the gate is parked — recorded on the parked
   * step and consumed by the durable driver when it re-enters the gate (the analogue of
   * `pendingIncorporation` on a requirements gate). Cleared once the driver acts on it.
   */
  pendingAction: v.optional(
    v.nullable(
      v.object({
        type: v.picklist(['confirm', 'request-fix', 'pull-main', 'recreate']),
        /** The findings prompt for a `request-fix` action. */
        findings: v.optional(v.string()),
      }),
    ),
  ),
})
export type HumanTestStepState = v.InferOutput<typeof humanTestStepStateSchema>

/**
 * One actual-vs-reference pairing the visual-confirmation gate shows the human: a logical
 * view, the screenshot the UI tester captured of it (`actualArtifactId`), and the reference
 * design image for the same view when one was uploaded (`referenceArtifactId`). Either side
 * may be absent (a captured view with no reference, or a reference whose view wasn't captured).
 */
export const visualConfirmPairSchema = v.object({
  view: v.string(),
  actualArtifactId: v.optional(v.nullable(v.string())),
  referenceArtifactId: v.optional(v.nullable(v.string())),
})
export type VisualConfirmPair = v.InferOutput<typeof visualConfirmPairSchema>

/** One human-requested fix round on a visual-confirmation gate (dispatches the `fixer`). */
export const visualConfirmRoundSchema = v.object({
  findings: v.string(),
  helperKind: v.string(),
  jobId: v.optional(v.nullable(v.string())),
  outcome: v.optional(v.nullable(v.picklist(['completed', 'failed']))),
  at: v.number(),
})
export type VisualConfirmRound = v.InferOutput<typeof visualConfirmRoundSchema>

/**
 * State a `visual-confirmation` gate carries while it runs. Like `human-test` there is no
 * programmatic verdict — a HUMAN reviews the UI tester's screenshots against the uploaded
 * reference designs and approves, or requests a fix (which dispatches the `fixer` and then
 * re-captures via the UI tester). Phases:
 *   - `awaiting_human`— parked: the human reviews actual-vs-reference and approves / requests a fix.
 *   - `fixing`        — a `fixer` job (from the human's findings) is in flight.
 *   - `approved`      — the human approved; the run advances.
 *
 * (A dedicated `capturing` phase for an auto re-run of the UI tester after a fix is deferred
 * until that loop is wired — see the visual-confirmation handover doc — so it is intentionally
 * absent from the picklist rather than carried as dead state.)
 */
export const visualConfirmPhaseSchema = v.picklist(['awaiting_human', 'fixing', 'approved'])
export type VisualConfirmPhase = v.InferOutput<typeof visualConfirmPhaseSchema>

export const visualConfirmStepStateSchema = v.object({
  phase: visualConfirmPhaseSchema,
  /** The actual-vs-reference pairs the human reviews, refreshed on each (re)capture. */
  pairs: v.optional(v.array(visualConfirmPairSchema)),
  /** Set when no screenshots could be gathered (no UI tester ran / no storage) — manual mode. */
  degradedReason: v.optional(v.nullable(v.string())),
  /** How many fixer attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on fixer attempts, resolved from the task's merge preset (`ciMaxAttempts`). */
  maxAttempts: v.number(),
  /** Append-only history of fix rounds; see {@link visualConfirmRoundSchema}. */
  rounds: v.optional(v.array(visualConfirmRoundSchema)),
  /**
   * Transient action the human requested while parked — consumed by the durable driver
   * when it re-enters the gate. Cleared once acted on.
   */
  pendingAction: v.optional(
    v.nullable(
      v.object({
        type: v.picklist(['approve', 'request-fix', 'recapture']),
        /** The findings prompt for a `request-fix` action. */
        findings: v.optional(v.string()),
      }),
    ),
  ),
})
export type VisualConfirmStepState = v.InferOutput<typeof visualConfirmStepStateSchema>
