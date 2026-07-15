import * as v from 'valibot'

// ---------------------------------------------------------------------------
// PR deep-review wire contracts. A `review` task runs the read-only `pr-reviewer`
// container agent over an EXISTING open pull request: it slices the diff into
// cohesive chunks and reviews each within a bounded context, returning prioritized
// findings. Rather than finishing the run the moment the agent returns (PR 1's
// behaviour), the engine records the sliced findings onto the run's `pr-reviewer`
// step (`step.prReview`) and PARKS for a human to visually SELECT which findings
// matter through the dedicated review window, then resolve.
//
// All review state rides the run's `pr-reviewer` step (`PipelineStep.prReview`) —
// no side table — so it is runtime-symmetric by construction, exactly like
// `forkDecision` / `followUps`. The two terminal resolutions (feed the selected
// findings to a Fixer, or post them as inline PR review comments) are the tracked
// follow-up (PR 3); PR 2 ships the slicing → park → multi-select loop with a
// neutral `finish` resolution.
// ---------------------------------------------------------------------------

/**
 * How serious a finding is, ordered blocker → nit. The window groups + sorts by this and
 * renders a colour per level; the engine sorts the aggregated findings blocker-first.
 */
export const prReviewSeveritySchema = v.picklist(['blocker', 'high', 'medium', 'low', 'nit'])
export type PrReviewSeverity = v.InferOutput<typeof prReviewSeveritySchema>

/** What area a finding concerns — drives the window's category chip. */
export const prReviewCategorySchema = v.picklist([
  'correctness',
  'security',
  'performance',
  'maintainability',
  'style',
  'test',
  'other',
])
export type PrReviewCategory = v.InferOutput<typeof prReviewCategorySchema>

/**
 * One cohesive slice the reviewer grouped the changed files into (a refactor + its call
 * sites + its tests). The window groups findings under their slice. `id` is engine-minted
 * (`prs_*`) when the reviewer's output is recorded onto the step.
 */
export const prReviewSliceSchema = v.object({
  /** Engine-minted stable id (`prs_*`); assigned when the reviewer's output is recorded. */
  id: v.string(),
  /** Short name of the slice. */
  title: v.string(),
  /** Why these files belong together. */
  rationale: v.string(),
  /** The repo-relative paths that make up the slice. */
  paths: v.array(v.string()),
})
export type PrReviewSlice = v.InferOutput<typeof prReviewSliceSchema>

/**
 * One prioritized review finding, id-stamped by the engine and anchored to a slice. Carries
 * everything the window needs to render it and everything PR 3's resolutions consume (the
 * `path`/`line`/`side` anchor for an inline PR comment; the `suggestedFix` for the Fixer).
 */
export const prReviewFindingSchema = v.object({
  /** Engine-minted stable id (`prf_*`); the multi-select carries these ids. */
  id: v.string(),
  /** The slice this finding belongs to (`prs_*`), or null when it matched no slice. */
  sliceId: v.optional(v.nullable(v.string())),
  /** Repo-relative path the finding concerns. */
  path: v.string(),
  /** The line the finding anchors to on the PR head (for an inline comment), or null. */
  line: v.optional(v.nullable(v.number())),
  /** Which side of the diff the line is on; `RIGHT` (head) unless it concerns a removed line. */
  side: v.optional(v.nullable(v.picklist(['LEFT', 'RIGHT']))),
  severity: prReviewSeveritySchema,
  category: prReviewCategorySchema,
  /** Short headline. */
  title: v.string(),
  /** The full finding, in prose. */
  detail: v.string(),
  /** A concrete suggested change, when the reviewer offered one. */
  suggestedFix: v.optional(v.nullable(v.string())),
})
export type PrReviewFinding = v.InferOutput<typeof prReviewFindingSchema>

/**
 * The PR-review lifecycle on a `pr-reviewer` step:
 * - `reviewing`: the read-only reviewer container job is in flight (the agent dispatch).
 * - `awaiting_selection`: parked; the human curates which findings matter through the window.
 * - `fixing` / `posting`: a resolution is executing (PR 3 — the Fixer commits, or inline
 *   comments are posted). Unused in PR 2.
 * - `done`: the review is resolved (the human finished; PR 3: fixed / posted).
 * - `skipped`: the reviewer isn't wired / produced nothing to review — the step passed through.
 */
export const prReviewStatusSchema = v.picklist([
  'reviewing',
  'awaiting_selection',
  'fixing',
  'posting',
  'done',
  'skipped',
])
export type PrReviewStatus = v.InferOutput<typeof prReviewStatusSchema>

/**
 * How the human resolved the review. PR 2 ships only `finish` (curate the selection + complete
 * the read-only review); PR 3 adds `fix` (feed the selected findings to a Fixer) and `post`
 * (post them as inline PR review comments). Adding members later is a non-breaking extension
 * (backwards compatibility is a non-goal — see CLAUDE.md).
 */
export const prReviewResolutionSchema = v.picklist(['finish'])
export type PrReviewResolution = v.InferOutput<typeof prReviewResolutionSchema>

/**
 * Live PR-review state carried on the run's `pr-reviewer` step. Recorded by the engine when
 * the reviewer container job completes (the sliced, severity-ordered findings), then mutated
 * by the human's selection + resolution. `prUrl` is the reviewed PR (for the window header);
 * `model` records the reviewing model for transparency.
 */
export const prReviewStepStateSchema = v.object({
  status: prReviewStatusSchema,
  /** The reviewer's one-paragraph overall assessment of the PR, when it gave one. */
  summary: v.optional(v.nullable(v.string())),
  /** The cohesive slices the reviewer grouped the changed files into. */
  slices: v.optional(v.array(prReviewSliceSchema), []),
  /** The findings, ordered by severity (blocker → nit). */
  findings: v.optional(v.array(prReviewFindingSchema), []),
  /** The finding ids the human selected to act on (curated in the window). */
  selectedFindingIds: v.optional(v.array(v.string()), []),
  /** How the human resolved the review; null while awaiting selection. */
  resolution: v.optional(v.nullable(prReviewResolutionSchema)),
  /** Web URL of the reviewed pull request, when known. */
  prUrl: v.optional(v.nullable(v.string())),
  /** Identifier of the model that produced the review, for transparency. */
  model: v.optional(v.nullable(v.string())),
})
export type PrReviewStepState = v.InferOutput<typeof prReviewStepStateSchema>

// ---- Reviewer agent output (lenient) --------------------------------------

/**
 * The LENIENT structured shape the read-only `pr-reviewer` container agent returns as
 * `result.custom` (the engine mints slice/finding ids and records it onto the step). Every
 * field falls back to a safe default (`v.fallback`) — exactly like `forkProposal` — so a
 * partially-malformed reply degrades to sensible defaults rather than failing the run: an
 * unreadable severity/category reads as its safe default, and each list degrades to empty.
 * This is the SINGLE source of truth for the reviewer's output shape, consumed both by the
 * agent kind's `defineStructuredOutput` (validation at completion) and the engine's coercion.
 */
export const prReviewAgentOutputSchema = v.object({
  /** One-paragraph overall assessment of the PR. */
  summary: v.fallback(v.optional(v.string()), undefined),
  /** The cohesive slices the reviewer grouped the changed files into. */
  slices: v.fallback(
    v.array(
      v.fallback(
        v.object({
          title: v.fallback(v.string(), ''),
          rationale: v.fallback(v.string(), ''),
          paths: v.fallback(v.array(v.fallback(v.string(), '')), []),
        }),
        { title: '', rationale: '', paths: [] },
      ),
    ),
    [],
  ),
  /** The findings, ordered by severity (blocker → nit). */
  findings: v.fallback(
    v.array(
      v.fallback(
        v.object({
          path: v.fallback(v.string(), ''),
          line: v.fallback(v.optional(v.number()), undefined),
          side: v.fallback(v.optional(v.picklist(['LEFT', 'RIGHT'])), undefined),
          severity: v.fallback(prReviewSeveritySchema, 'medium'),
          category: v.fallback(prReviewCategorySchema, 'other'),
          title: v.fallback(v.string(), ''),
          detail: v.fallback(v.string(), ''),
          suggestedFix: v.fallback(v.optional(v.string()), undefined),
        }),
        {
          path: '',
          severity: 'medium' as const,
          category: 'other' as const,
          title: '',
          detail: '',
        },
      ),
    ),
    [],
  ),
})
export type PrReviewAgentOutput = v.InferOutput<typeof prReviewAgentOutputSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Resolve a parked PR review: the human's curated selection (`findingIds`) plus how to resolve
 * it (`action`). PR 2 supports only `finish` — record the selection and complete the read-only
 * review. The Fixer / inline-comment resolutions are PR 3.
 */
export const resolvePrReviewSchema = v.object({
  action: v.optional(prReviewResolutionSchema, 'finish'),
  findingIds: v.optional(v.array(v.string()), []),
})
export type ResolvePrReviewInput = v.InferOutput<typeof resolvePrReviewSchema>
