import * as v from 'valibot'
import { vcsProviderSchema } from './routes/auth.js'

// ---------------------------------------------------------------------------
// Merge TRACK RECORD wire contracts — the accumulated human evidence behind the
// auto-merge policy.
//
// The merge decision itself runs on the `merger` agent's self-assessment (see
// `merge.ts`): scores vs the task's preset ceilings. This module models what the
// decision LEAVES BEHIND so the policy can eventually stand on evidence instead:
//
//   - WHAT KIND of change it was (a deterministic, path-derived {@link ChangeClass}),
//   - the merger's scores at the moment of the decision,
//   - how much review effort a human actually spent ({@link ReviewEffort}, nullable
//     until somebody tags it — tagging is never mandatory),
//   - and what happened ({@link MergeTrackDecision}).
//
// Per-class rollups of those records are what justify WIDENING a policy, which is
// why merge presets carry per-class rules ({@link MergeClassRules} in `merge.ts`).
//
// Full design — the class precedence rules, the external-merge detection, and the
// preset reshape — is in `backend/docs/adr/0046-merge-track-record.md`.
// ---------------------------------------------------------------------------

/**
 * What kind of change a run's pull request made, derived DETERMINISTICALLY on the backend
 * from the PR's changed-file list (never from an agent's opinion). A small closed set so it
 * can key a per-class merge rule, a rollup `GROUP BY`, and an i18n label.
 *
 *  - `docs`       — documentation + user-facing copy (Markdown, `docs/`, i18n catalogs).
 *  - `test`       — test/spec/fixture files only.
 *  - `dependency` — dependency manifests + lockfiles (a bump).
 *  - `config`     — CI workflows, tooling config, container/IaC manifests.
 *  - `source`     — application/library source code (the catch-all for real code).
 *  - `schema`     — database migrations + schema definitions (the riskiest: irreversible).
 *  - `unknown`    — no changed-file list was available (no VCS client wired, or an empty diff).
 *
 * A MIXED diff resolves to the HIGHEST-RANKED class present (see `CHANGE_CLASS_RANK` /
 * `classifyChangedFiles` in `@cat-factory/kernel`), so a per-class rule can only ever fire on a
 * diff containing nothing riskier than that class.
 */
export const changeClassSchema = v.picklist([
  'docs',
  'test',
  'dependency',
  'config',
  'source',
  'schema',
  'unknown',
])
export type ChangeClass = v.InferOutput<typeof changeClassSchema>

/**
 * Every {@link ChangeClass} in rank order (lowest → highest risk), `unknown` last. The
 * ordering the preset editor renders and the rollup table iterates, so a new class is added
 * in ONE place. `unknown` is deliberately last: it is a fallback outcome, not a policy target.
 */
export const CHANGE_CLASSES = [
  'docs',
  'test',
  'dependency',
  'config',
  'source',
  'schema',
  'unknown',
] as const satisfies readonly ChangeClass[]

/**
 * The classes a per-class merge RULE may be authored for — every class except `unknown`.
 * `unknown` must stay inert: an unclassifiable diff (a transient VCS outage) has to fall
 * back to the score thresholds rather than silently adopt a widened policy.
 */
export const RULEABLE_CHANGE_CLASSES = [
  'docs',
  'test',
  'dependency',
  'config',
  'source',
  'schema',
] as const satisfies readonly ChangeClass[]

export type RuleableChangeClass = (typeof RULEABLE_CHANGE_CLASSES)[number]

/**
 * How much review effort a human actually spent on a pull request before merging it — the
 * ground truth the auto-merge score thresholds are trying to approximate.
 *
 *  - `none`  — merged with zero blocking comments.
 *  - `minor` — small comments / a nit pass, no substantive rework.
 *  - `major` — real rework was required.
 *
 * ALWAYS optional: an untagged merge records a null tag and every consumer treats null as
 * "not tagged", never as `none`.
 */
export const reviewEffortSchema = v.picklist(['none', 'minor', 'major'])
export type ReviewEffort = v.InferOutput<typeof reviewEffortSchema>

/** Every {@link ReviewEffort} in ascending order — the chip order the SPA renders. */
export const REVIEW_EFFORTS = ['none', 'minor', 'major'] as const satisfies readonly ReviewEffort[]

/**
 * What ultimately happened to the pull request a track record covers.
 *
 *  - `pending_review`   — the merger step routed it to a human; not yet resolved. Recorded at
 *    the decision so the class + scores are captured even if the human never comes back.
 *  - `auto_merged`      — the engine merged it on the policy (thresholds or a class rule).
 *  - `human_merged`     — a human confirmed the merge THROUGH cat-factory (a notification act
 *    or the inspector's merge control).
 *  - `external_merged`  — a human merged it directly on the VCS provider, bypassing
 *    cat-factory; detected from the webhook ingest.
 *  - `rejected`         — a human dismissed the review card instead of merging.
 */
export const mergeTrackDecisionSchema = v.picklist([
  'pending_review',
  'auto_merged',
  'human_merged',
  'external_merged',
  'rejected',
])
export type MergeTrackDecision = v.InferOutput<typeof mergeTrackDecisionSchema>

const scoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))

/**
 * One persisted merge decision: what kind of change it was, what the merger scored it, what
 * the engine/human did, and how much review effort it needed. Written best-effort off the
 * merge path — a failure to write one NEVER blocks or fails a merge.
 *
 * Provider-neutral by construction: the repo identity is `repoId` + `provider` (the kernel
 * `VcsRepoRef`/`VcsProvider` vocabulary), never a GitHub-shaped `githubId`/`installationId`.
 */
export const mergeTrackRecordSchema = v.object({
  /**
   * Deterministic id, derived from the run: `mtr_<executionId>`. Deterministic so a durable-driver
   * replay of a settled merger step collides with the row it already wrote (first write wins)
   * instead of duplicating it.
   */
  id: v.string(),
  /** The task/block whose pull request this covers. */
  blockId: v.string(),
  /**
   * The run that produced the PR. Nullable at the wire/storage level because the column is, but
   * every record written today is born at a merge DECISION POINT inside a run, so it is set. An
   * external merge does not MINT a record — it settles the one the run already wrote (which is
   * also why attribution keys on `(repoId, prNumber)`); a PR cat-factory never opened has no
   * record and is correctly invisible to the track record.
   */
  executionId: v.nullable(v.string()),
  /** The deterministic, path-derived change class (see {@link changeClassSchema}). */
  changeClass: changeClassSchema,
  /** How many files the PR changed, when the changed-file list was readable. */
  changedFileCount: v.nullable(v.number()),
  /** The merger's complexity score at the decision, when it produced a parseable assessment. */
  complexity: v.nullable(scoreSchema),
  /** The merger's risk score at the decision, when one was produced. */
  risk: v.nullable(scoreSchema),
  /** The merger's impact score at the decision, when one was produced. */
  impact: v.nullable(scoreSchema),
  /** The merge preset the decision was made against, for reading a record back in context. */
  riskPolicyId: v.nullable(v.string()),
  riskPolicyName: v.nullable(v.string()),
  /** What happened (see {@link mergeTrackDecisionSchema}). */
  decision: mergeTrackDecisionSchema,
  /** The human's effort tag — null until somebody tags it. Tagging is never mandatory. */
  reviewEffort: v.nullable(reviewEffortSchema),
  /** The PR number within its repo, when known. */
  prNumber: v.nullable(v.number()),
  /** The PR's web URL, for the card's deep link. */
  prUrl: v.nullable(v.string()),
  /** Provider-neutral repo id the PR belongs to (`VcsRepoRef.repoId`). */
  repoId: v.nullable(v.string()),
  /** Which VCS provider hosts it — so a mixed-provider workspace reads back correctly. */
  provider: v.nullable(vcsProviderSchema),
  /** Epoch ms the decision was recorded (the merger step's resolution). */
  createdAt: v.number(),
  /** Epoch ms the decision reached a terminal value; null while `pending_review`. */
  resolvedAt: v.nullable(v.number()),
  /** Epoch ms the effort tag was recorded; null while untagged. */
  taggedAt: v.nullable(v.number()),
})
export type MergeTrackRecord = v.InferOutput<typeof mergeTrackRecordSchema>

// ---------------------------------------------------------------------------
// Per-class rollups — SQL aggregates (COUNT / GROUP BY / conditional SUM), never
// rows loaded and reduced in JS. ONE query per workspace returns every class, so
// the preset editor's stats load in a single round-trip.
// ---------------------------------------------------------------------------

/** The per-effort-level counts within a class's rollup. `untagged` counts null tags. */
export const reviewEffortDistributionSchema = v.object({
  none: v.number(),
  minor: v.number(),
  major: v.number(),
  untagged: v.number(),
})
export type ReviewEffortDistribution = v.InferOutput<typeof reviewEffortDistributionSchema>

/** One change class's accumulated track record — the number that justifies widening a rule. */
export const mergeClassRollupSchema = v.object({
  changeClass: changeClassSchema,
  /** Every record in the class, including still-`pending_review` ones. */
  total: v.number(),
  /** Records whose PR landed (auto + human + external) — the auto-merge-share denominator. */
  merged: v.number(),
  autoMerged: v.number(),
  humanMerged: v.number(),
  externalMerged: v.number(),
  rejected: v.number(),
  pendingReview: v.number(),
  effort: reviewEffortDistributionSchema,
})
export type MergeClassRollup = v.InferOutput<typeof mergeClassRollupSchema>

/**
 * The auto-merge share of a class's LANDED records, 0..1, or null when nothing has landed
 * yet (so the UI shows "no data" rather than a misleading 0%). Shared by the preset editor
 * and any backend consumer so the two can never disagree.
 */
export function autoMergeShare(rollup: MergeClassRollup): number | null {
  if (rollup.merged === 0) return null
  return rollup.autoMerged / rollup.merged
}

/**
 * The share of a class's TAGGED records that needed no blocking comments, 0..1, or null when
 * nothing in the class has been tagged. This — not the auto-merge share — is the evidence that
 * justifies flipping a class to `always`: it says humans found nothing to say.
 */
export function frictionlessShare(rollup: MergeClassRollup): number | null {
  const tagged = rollup.effort.none + rollup.effort.minor + rollup.effort.major
  if (tagged === 0) return null
  return rollup.effort.none / tagged
}

/** An empty rollup for a class with no records yet (the UI renders every class, always). */
export function emptyMergeClassRollup(changeClass: ChangeClass): MergeClassRollup {
  return {
    changeClass,
    total: 0,
    merged: 0,
    autoMerged: 0,
    humanMerged: 0,
    externalMerged: 0,
    rejected: 0,
    pendingReview: 0,
    effort: { none: 0, minor: 0, major: 0, untagged: 0 },
  }
}

// ---- Request bodies -------------------------------------------------------

/**
 * Body of `POST /blocks/:blockId/merge` — the inspector's merge control. Every field is optional,
 * so `{}` is the historical no-body merge; `reviewEffort` records the effort tag onto the block's
 * merge track record in the same request (the counterpart of the notification card's `act` body).
 */
export const mergeBlockSchema = v.object({
  reviewEffort: v.optional(v.nullable(reviewEffortSchema)),
})
export type MergeBlockInput = v.InferOutput<typeof mergeBlockSchema>

/** Tag a record with the review effort a human actually spent (`null` clears the tag). */
export const tagReviewEffortSchema = v.object({
  reviewEffort: v.nullable(reviewEffortSchema),
})
export type TagReviewEffortInput = v.InferOutput<typeof tagReviewEffortSchema>

// ---- Refusal vocabulary ---------------------------------------------------

/**
 * `error.details.reason` for "no merge record under that id in this workspace": the 404 BOTH
 * record-addressed routes answer, the read and the tag alike.
 *
 * It is a constant rather than a literal per site because the two producers live in different
 * packages: the read resolves the row in `@cat-factory/server` and refuses there, while the tag
 * write refuses inside `MergeTrackRecordService` (a lost race between reading and patching is the
 * service's to detect, not a controller's to pre-check). A machine-readable code that two packages
 * spell independently is one rename away from a caller branching on a value only one route emits.
 *
 * Distinct from `no_merge_record`, which the RUN-scoped read answers for a readable run that
 * simply made no merge decision: that is a fact about the run, not a missing id.
 */
export const MERGE_RECORD_NOT_FOUND_REASON = 'merge_record_not_found'
