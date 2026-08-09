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
 * Where a pair's reference image came from: a person UPLOADED it against this task, or an import
 * of a linked DESIGN document retained it as a rendered frame.
 *
 * The two are not interchangeable to a reviewer. An upload is a deliberate act against this one
 * task and outlives every re-import; a design render is a projection of a live document that the
 * next body-changing import replaces wholesale. So "this is what your Figma file says today" and
 * "this is the mock someone attached" are different claims, and the surface states which it is
 * showing rather than presenting both as one anonymous "reference".
 */
export const visualConfirmReferenceOriginSchema = v.picklist(['upload', 'design'])
export type VisualConfirmReferenceOrigin = v.InferOutput<typeof visualConfirmReferenceOriginSchema>

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
  /**
   * Where `referenceArtifactId` came from. Absent when the pair has no reference, and ALSO when
   * the capture named its own reference: a reference the gate did not source is one whose
   * provenance it can only guess at, and "unknown" is a different answer from "an upload".
   */
  referenceOrigin: v.optional(v.nullable(visualConfirmReferenceOriginSchema)),
})
export type VisualConfirmPair = v.InferOutput<typeof visualConfirmPairSchema>

/**
 * Why a linked design contributed no (or not all of its) reference images.
 *
 * Every one of these renders to the reviewer as the same absence (a design is attached and its
 * screens are not on the screen), and each asks for a different fix, which is the whole reason
 * the gate states them instead of showing a shorter gallery. Derived from the document's own
 * {@link DocumentRenderStatus} plus what the artifact store actually holds, never from the status
 * alone: a row claiming `stored` over an empty shelf is exactly the case a reviewer must not read
 * as "this design has no screens".
 */
export const visualConfirmDesignGapReasonSchema = v.picklist([
  /** Some frames were retained and some were not: the gallery is missing part of the design. */
  'partial',
  /** The last import's render read failed outright. Refreshing the document is the fix. */
  'failed',
  /** The source offered no frame to rasterise (an empty file). Nothing to fix. */
  'none',
  /** No image storage was configured when the design was imported, so nothing was downloaded. */
  'storage_unavailable',
  /**
   * No images are held for this design, and its last import either recorded no render outcome or
   * claimed one that the shelf does not bear out (`stored` / `partial` over nothing held). The
   * causes it covers all end in the same place: the source may not rasterise at all, the document
   * may predate render retention, or the frames it did keep are gone. Re-importing is what tells
   * them apart, and is the fix for each.
   */
  'not_retained',
])
export type VisualConfirmDesignGapReason = v.InferOutput<typeof visualConfirmDesignGapReasonSchema>

/**
 * One linked design that contributed less than its whole set of frames.
 *
 * A design can fall short in two INDEPENDENT ways, so the entry carries both rather than picking
 * one: its source kept fewer frames than the design has (`reason`), and the gallery's own ceiling
 * left out some of what it did keep (`dropped`). A design can be short on either axis alone or on
 * both, and collapsing them into a single field would silently drop whichever lost the coin toss.
 */
export const visualConfirmDesignGapSchema = v.object({
  /** The document's title, so the reviewer knows WHICH design is short. */
  title: v.string(),
  /**
   * Why the SOURCE holds fewer frames than the design has, or null when retention is complete and
   * this entry exists only because the gallery ceiling dropped some of them.
   */
  reason: v.nullable(visualConfirmDesignGapReasonSchema),
  /**
   * How many of THIS design's views the gallery's ceiling left out. Per-design rather than only in
   * the summary's total, because the budget is shared: a bare total says frames are missing
   * without saying whose, and a design the ceiling shut out entirely would otherwise look to a
   * reviewer exactly like one that has no frames at all.
   */
  dropped: v.optional(v.number()),
})
export type VisualConfirmDesignGap = v.InferOutput<typeof visualConfirmDesignGapSchema>

/**
 * What the task's LINKED DESIGNS contributed to the gallery, stated separately from the pairs
 * themselves.
 *
 * Present whenever the task links at least one design document, even when everything worked: a
 * reviewer approving a screen against a Figma frame needs to know the frame is the design's own
 * and not a hand-uploaded mock, and a reviewer seeing nothing needs to know whether a design is
 * linked at all. ABSENT means the task links no design, which is a different fact from "links one
 * and it gave nothing".
 */
export const visualConfirmDesignReferencesSchema = v.object({
  /** Linked design documents considered. */
  documents: v.number(),
  /** Rendered frames folded into the pairs above. */
  images: v.number(),
  /**
   * Frames left out by the gate's own ceiling on how many design views one gallery may carry,
   * summed across every linked design. Reported rather than silently trimmed: unstated, a capped
   * gallery reads as the whole design. Which designs the ceiling cut, and by how much, is on each
   * one's own {@link visualConfirmDesignGapSchema} entry.
   */
  dropped: v.optional(v.number()),
  /** Designs that contributed less than their whole set; see {@link visualConfirmDesignGapSchema}. */
  gaps: v.optional(v.array(visualConfirmDesignGapSchema)),
})
export type VisualConfirmDesignReferences = v.InferOutput<
  typeof visualConfirmDesignReferencesSchema
>

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
  /**
   * What the task's linked DESIGNS contributed, when it links any. Kept apart from
   * {@link degradedReason} because that field gates the approve button behind an "I reviewed this
   * another way" acknowledgement, and a design that gave fewer frames than it has is not a
   * degraded review BASIS: a task's references have always been optional. See
   * {@link visualConfirmDesignReferencesSchema}.
   */
  designReferences: v.optional(v.nullable(visualConfirmDesignReferencesSchema)),
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
