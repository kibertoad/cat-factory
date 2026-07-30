import * as v from 'valibot'
import { fragmentAdherenceSchema } from './fragment-adherence.js'

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
// `forkDecision` / `followUps`. The human resolves the parked review one of three ways:
// `finish` (record the curated selection), `fix` (feed the selected findings to a Fixer
// that commits fixes onto the reviewed PR's branch) or `post` (publish them as inline PR
// review comments). See backend/docs/adr/0023-pr-deep-review.md.
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
 * One slice's review as captured WHILE the reviewer was still running, rather than at completion.
 *
 * WHY THIS EXISTS. The reviewer fans the slices out across parallel subagents and only returns
 * `slices`/`findings` in its TERMINAL structured output, so until the aggregation pass finishes
 * the step holds nothing but progress counts. A review that dies in that window — the harness
 * inactivity/max-duration watchdog, an evicted container, a stuck aggregation — therefore loses
 * every completed slice's work and can only be re-run from zero. The motivating incident spent 18
 * minutes and 25M input tokens, of which the last 196 seconds were a single silent aggregation
 * turn: had it been killed there, all eight finished slices would have been thrown away.
 *
 * The subagent's terminal report IS visible on the parent stream (its dispatch and its
 * `tool_result` both appear there — only the intermediate turns don't), so the harness captures it
 * per slice and publishes it here as the slices land. That makes completed review work durable
 * independently of the aggregation, which is what lets a stuck review be RESUMED for only the
 * slices that never finished (see `resumePrReviewSchema`).
 *
 * `report` is the subagent's verbatim prose, NOT structured findings: turning it into
 * {@link prReviewFindingSchema} entries is the aggregation pass's job, and doing it here would mean
 * a second model call per slice. A resume therefore re-aggregates from these reports instead of
 * re-reviewing the slices they came from.
 */
export const prReviewSliceReviewSchema = v.object({
  /** The slice label the reviewer dispatched the subagent with, used to pair progress + resume. */
  label: v.string(),
  /**
   * Whether this slice's subagent finished. An `in_progress` slice is one the reviewer dispatched
   * but never got a result for, so a resume re-reviews it (its `report` is null).
   */
  status: v.picklist(['in_progress', 'completed']),
  /**
   * The subagent's verbatim terminal report for this slice; null while `in_progress`. Bounded by
   * the harness before it is published (a slice report is prose, not a transcript).
   */
  report: v.optional(v.nullable(v.string())),
})
export type PrReviewSliceReview = v.InferOutput<typeof prReviewSliceReviewSchema>

/** Parse one untrusted slice review (a harness payload), or `null` when unusable. */
export function parsePrReviewSliceReview(input: unknown): PrReviewSliceReview | null {
  const parsed = v.safeParse(prReviewSliceReviewSchema, input)
  return parsed.success ? parsed.output : null
}

/**
 * A finding's CHALLENGE lifecycle. A human can challenge a finding — optionally with a specific
 * question / concern — which dispatches the read-only **Challenge Investigator** container agent
 * to dig into the finding against the FULL source. Terminal verdicts:
 * - `upheld` — the finding holds up AS WRITTEN (the investigator kept it, adding a justification
 *   but no revision to its body).
 * - `amended` — the finding holds up AND the investigator strengthened/clarified it (some field —
 *   title / detail / severity / suggested fix — actually changed).
 * - `retracted` — the finding does NOT hold up; it is auto-deselected and rendered struck-through
 *   beside its retraction justification.
 *
 * While the investigator runs the finding carries `investigating`. If its container job FAILS
 * (crash / non-transient error) the challenge settles as `failed` — the finding is left exactly as
 * it was (never dropped) and the review re-parks so the human can re-challenge or proceed, rather
 * than the whole parked review failing over a non-critical second opinion.
 */
export const prReviewFindingChallengeSchema = v.object({
  /**
   * Lifecycle: `investigating` (agent in flight) → `upheld` (holds as-is) | `amended` (upheld +
   * strengthened) | `retracted` (dropped) | `failed` (the investigation couldn't complete).
   */
  status: v.picklist(['investigating', 'upheld', 'amended', 'retracted', 'failed']),
  /**
   * The human's specific challenge / question / concern, or null when they challenged with no
   * text (the generic "dig deeper, justify the grounding, validate accuracy + relevance" prompt).
   */
  question: v.optional(v.nullable(v.string())),
  /**
   * The investigator's justification — why the finding holds up (`upheld`/`amended`) or why it does
   * not (`retracted`). For `failed` it carries the failure reason. Null while `investigating`.
   */
  justification: v.optional(v.nullable(v.string())),
})
export type PrReviewFindingChallenge = v.InferOutput<typeof prReviewFindingChallengeSchema>

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
  /**
   * The finding's challenge state, when a human challenged it (see
   * {@link prReviewFindingChallengeSchema}). Absent for an un-challenged finding.
   */
  challenge: v.optional(v.nullable(prReviewFindingChallengeSchema)),
})
export type PrReviewFinding = v.InferOutput<typeof prReviewFindingSchema>

/**
 * The PR-review lifecycle on a `pr-reviewer` step:
 * - `reviewing`: the read-only reviewer container job is in flight (the agent dispatch).
 * - `awaiting_selection`: parked; the human curates which findings matter through the window.
 * - `challenging`: a human challenged a finding, so the read-only Challenge Investigator container
 *   job is in flight digging into it; the review returns to `awaiting_selection` once its verdict
 *   (strengthen the finding, or retract it) is applied.
 * - `fixing` / `posting`: a resolution is executing — the Fixer is committing fixes onto the
 *   PR branch (`fixing`), or the selected findings are being posted as inline comments (`posting`).
 * - `done`: the review is resolved (the human finished; PR 3: fixed / posted).
 * - `skipped`: the reviewer isn't wired / produced nothing to review — the step passed through.
 */
export const prReviewStatusSchema = v.picklist([
  'reviewing',
  'awaiting_selection',
  'challenging',
  'fixing',
  'posting',
  'done',
  'skipped',
])
export type PrReviewStatus = v.InferOutput<typeof prReviewStatusSchema>

/**
 * How the human resolved the review:
 * - `finish` — curate the selection + complete the read-only review (no side effect).
 * - `fix` — feed the selected findings to a Fixer, which clones the reviewed PR's head branch,
 *   commits fixes addressing them, and pushes back onto it (reusing `FIXER_AGENT_KIND`).
 * - `post` — publish the selected findings as inline PR review comments (a single advisory
 *   `COMMENT` review) without changing any code.
 *
 * `fix`/`post` require at least one selected finding (there is nothing to act on otherwise).
 */
export const prReviewResolutionSchema = v.picklist(['finish', 'fix', 'post'])
export type PrReviewResolution = v.InferOutput<typeof prReviewResolutionSchema>

/**
 * One selected finding whose inline comment could NOT be posted, with the reason. Surfaced in
 * the window so a partial post is legible rather than a silent drop. `line` is the anchor that
 * was rejected (e.g. a line outside the PR diff → GitHub's "Line could not be resolved").
 */
export const prReviewPostFailureSchema = v.object({
  /** The finding whose comment failed (`prf_*`). */
  findingId: v.string(),
  /** The path the comment anchored to. */
  path: v.string(),
  /** The line the comment anchored to, when it had one. */
  line: v.optional(v.nullable(v.number())),
  /** Human-readable reason the post failed (the VCS error message). */
  reason: v.string(),
})
export type PrReviewPostFailure = v.InferOutput<typeof prReviewPostFailureSchema>

/**
 * The outcome of the most recent `post` resolution: how many of the selected findings' inline
 * comments were published, which failed and why, and how many findings were folded into the
 * summary comment because their line isn't part of the PR diff (so they can't be anchored
 * inline — the root cause of GitHub's "Line could not be resolved" 422). The window renders
 * this so a partial/failed post is visible AND retryable, instead of the run failing opaquely.
 */
export const prReviewPostReportSchema = v.object({
  /** Inline comments attempted (the selected, diff-anchorable findings). */
  attempted: v.number(),
  /** How many of those posted successfully. */
  posted: v.number(),
  /**
   * Findings that HAD a line but were folded into the summary comment because that line falls
   * outside the PR diff (so GitHub can't anchor an inline comment there) — this is how the 422
   * is avoided at the source. A truly line-less finding is summarised too but is NOT counted
   * here (it never could be an inline comment): `attempted` + `folded` therefore counts only the
   * findings that carried a line, not every selected finding.
   */
  folded: v.optional(v.number(), 0),
  /** Whether the summary/body comment posted; null when there was no body to post. */
  bodyPosted: v.optional(v.nullable(v.boolean())),
  /** The error posting the summary/body comment, when it failed. */
  bodyError: v.optional(v.nullable(v.string())),
  /** Per-finding inline-comment failures, in the order attempted. */
  failures: v.optional(v.array(prReviewPostFailureSchema), []),
})
export type PrReviewPostReport = v.InferOutput<typeof prReviewPostReportSchema>

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
  /**
   * Per-slice reviews captured live while the reviewer ran (see
   * {@link prReviewSliceReviewSchema}), keyed by slice label. Published by the harness as each
   * slice's subagent returns, so completed review work is durable BEFORE the aggregation pass —
   * this is what a {@link resumePrReviewSchema} resume re-aggregates from rather than re-reviewing.
   *
   * Distinct from {@link prReviewStepStateSchema}'s `slices`, which is the reviewer's own settled
   * slicing recorded at completion: these are the live observations, so the two can disagree (a
   * slice the reviewer regrouped mid-run, a slice that never finished). Survives
   * `resetStepForRerun` so a resume can read it, and is cleared only when a review is started
   * fresh.
   */
  sliceReviews: v.optional(v.array(prReviewSliceReviewSchema), []),
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
  /**
   * The PR head commit sha at the moment the review STARTED (captured when the reviewer was
   * dispatched), or null when it couldn't be resolved (no VCS wired / older run). The `post`
   * resolution compares it to the PR's CURRENT head: if the branch moved since the review, the
   * frozen finding line numbers may now point at shifted/different code, so every finding is
   * folded into the summary comment rather than anchored inline to a possibly-drifted line. Null
   * ⇒ the drift check is skipped (the pre-existing per-line diff filtering still applies).
   */
  reviewedHeadSha: v.optional(v.nullable(v.string())),
  /**
   * The outcome of the most recent `post` attempt (null until one runs). A partial or failed
   * post keeps the review parked at `awaiting_selection` carrying this report, so the window
   * shows what posted / what failed and the human can retry ONLY the posting (re-`post`) rather
   * than re-running the whole review.
   */
  postReport: v.optional(v.nullable(prReviewPostReportSchema)),
  /**
   * Finding ids whose inline comment already posted successfully. A re-`post` skips these, so
   * retrying after a partial failure never double-posts the comments that already landed
   * (at-most-once per finding).
   */
  postedFindingIds: v.optional(v.array(v.string()), []),
  /**
   * Whether the summary/body comment already posted successfully on a prior attempt. Sticky once
   * true — a re-`post` then suppresses the body so retrying after a partial failure never
   * double-posts the summary comment (the body's at-most-once guard, the analogue of
   * {@link postedFindingIds} for the single summary comment). Stays false until the body lands, so
   * a body that FAILED is retried.
   */
  postedBody: v.optional(v.boolean(), false),
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
  /**
   * Per-best-practice-standard adherence report (see {@link fragmentAdherenceSchema}): for each
   * best-practice fragment folded into the reviewer's prompt, a 1..10 rating of how well the PR
   * adheres plus the findings that standard surfaced. Empty when no standards were reachable.
   */
  fragmentAdherence: v.fallback(v.optional(fragmentAdherenceSchema), undefined),
})
export type PrReviewAgentOutput = v.InferOutput<typeof prReviewAgentOutputSchema>

// ---- Challenge Investigator agent output ----------------------------------

/**
 * The LENIENT structured shape the read-only **Challenge Investigator** container agent returns
 * as `result.custom` when a human challenges a finding. The engine applies it to the challenged
 * finding: an `upheld` verdict keeps the finding and strengthens/clarifies its body from any
 * supplied `revised*` field (folding the justification in), while a `retracted` verdict
 * auto-deselects the finding and records the justification beside it. Every field falls back to a
 * safe default (`v.fallback`) — exactly like {@link prReviewAgentOutputSchema} — so a
 * partially-malformed reply degrades sensibly (an unreadable verdict reads as `upheld`, KEEPING
 * the finding rather than silently dropping it) instead of failing the run. This is the SINGLE
 * source of truth for the investigator's output shape, consumed both by the agent kind's
 * `defineStructuredOutput` (validation at completion) and the engine's coercion.
 */
export const prReviewChallengeOutputSchema = v.object({
  /**
   * Does the finding hold up? `upheld` keeps it (and may strengthen it via the `revised*` fields);
   * `retracted` drops it from the selection because the challenge showed it is wrong / irrelevant.
   */
  verdict: v.fallback(v.picklist(['upheld', 'retracted']), 'upheld'),
  /** Why the finding holds up, or why it does not — surfaced beside the finding in the window. */
  justification: v.fallback(v.string(), ''),
  /** When upheld: a clarified / strengthened finding body replacing `detail` (optional). */
  revisedDetail: v.fallback(v.optional(v.string()), undefined),
  /** When upheld: a revised headline replacing `title` (optional). */
  revisedTitle: v.fallback(v.optional(v.string()), undefined),
  /** When upheld: a re-assessed severity (optional). */
  revisedSeverity: v.fallback(v.optional(prReviewSeveritySchema), undefined),
  /** When upheld: a revised concrete suggested fix replacing `suggestedFix` (optional). */
  revisedSuggestedFix: v.fallback(v.optional(v.string()), undefined),
})
export type PrReviewChallengeOutput = v.InferOutput<typeof prReviewChallengeOutputSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Resolve a parked PR review: the human's curated selection (`findingIds`) plus how to resolve
 * it (`action`). `finish` records the selection and completes the read-only review; `fix` feeds
 * the selected findings to a Fixer (which commits fixes onto the reviewed PR's branch); `post`
 * publishes them as inline PR review comments. `fix`/`post` require ≥1 selected finding.
 */
export const resolvePrReviewSchema = v.object({
  action: v.optional(prReviewResolutionSchema, 'finish'),
  findingIds: v.optional(v.array(v.string()), []),
})
export type ResolvePrReviewInput = v.InferOutput<typeof resolvePrReviewSchema>

/**
 * Manually re-trigger a PR review that is stuck mid-`reviewing`, preserving what already finished.
 *
 * The reviewer's own watchdogs cannot recover this state: `ProgressGuard` is event-driven (a fully
 * silent agent never trips it), the inactivity watchdog is fed by subagent transcript growth (so a
 * noisy-but-unproductive run keeps resetting it), and the only backstop is the 60-minute
 * max-duration kill. Between those, a review can sit with its slices finished and its aggregation
 * wedged for the better part of an hour with no way to nudge it.
 *
 * A resume re-dispatches the reviewer for ONLY the slices that never completed, feeding the
 * already-captured {@link prReviewSliceReviewSchema} reports back in as context so the finished
 * slices are re-aggregated rather than re-reviewed. There is no body: which slices to redo is
 * derived from the step's own `sliceReviews`, never supplied by the caller, so the request cannot
 * ask for work that contradicts what was actually observed.
 */
export const resumePrReviewSchema = v.object({})
export type ResumePrReviewInput = v.InferOutput<typeof resumePrReviewSchema>

/**
 * Challenge a parked finding: dispatch the Challenge Investigator with an OPTIONAL specific
 * concern. An omitted / blank `question` uses the generic prompt (dig deeper, justify the
 * grounding, validate the finding is accurate + relevant). The finding is named in the path.
 */
export const challengePrReviewFindingSchema = v.object({
  /**
   * The specific challenge / question / concern for the investigator to dig into. Omitted or
   * blank ⇒ the generic "dig deeper and validate this finding" prompt.
   */
  question: v.optional(v.string()),
})
export type ChallengePrReviewFindingInput = v.InferOutput<typeof challengePrReviewFindingSchema>
