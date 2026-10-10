import * as v from 'valibot'
import { taskSourceKindSchema } from './tasks.js'

// ---------------------------------------------------------------------------
// Bug-hunt wire contracts. A hunt is the INTERACTIVE dual of the recurring
// `bug-intake` step: a human picks a connected tracker and one of its boards, the
// backend reads that board's open + unassigned bugs, a model ranks them by impact
// against implementation complexity, and the human confirms one candidate — which is
// then adopted as a board task and driven through the standard bug-fix pipeline.
//
// The hunt itself is STATELESS: nothing is persisted, so there is no hunt table, no
// migration and no runtime-symmetry surface. The only durable effects happen at adopt
// time, and they are the ones that already exist (an imported issue, a board task, a run).
// ---------------------------------------------------------------------------

/**
 * One selectable board on a tracker: a Jira project, a Linear team. `id` is vendor-shaped and
 * handed straight back as the hunt's board scope, so the SPA never has to know which notion a
 * source uses.
 *
 * A REPO-BACKED source (GitHub Issues, GitLab Issues) has nothing to list here: its board is the
 * repository the hunt's service frame is linked to, resolved server-side, so listing one is
 * refused rather than answered with a picker that could scope a hunt at a stranger's repo.
 */
export const trackerBoardSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** A short vendor-side key/slug shown beside the name to disambiguate (may be empty). */
  key: v.string(),
})
export type TrackerBoard = v.InferOutput<typeof trackerBoardSchema>

export const trackerBoardsViewSchema = v.object({
  source: taskSourceKindSchema,
  boards: v.array(trackerBoardSchema),
})
export type TrackerBoardsView = v.InferOutput<typeof trackerBoardsViewSchema>

/** How sure the ranking model is about a candidate's assessment. */
export const bugHuntConfidenceSchema = v.picklist(['high', 'medium', 'low'])
export type BugHuntConfidence = v.InferOutput<typeof bugHuntConfidenceSchema>

/**
 * The model's assessment of ONE candidate. `impact` and `complexity` are 1–5 judgements;
 * `score` is NOT the model's — it is computed deterministically from the two, so the
 * ordering is reproducible and a model that can't do arithmetic can't reorder the list.
 */
export const bugHuntAnalysisSchema = v.object({
  /** How much fixing this bug is worth (1 = cosmetic, 5 = users blocked). */
  impact: v.number(),
  /** How hard the fix looks (1 = a contained change, 5 = deep or unclear). */
  complexity: v.number(),
  /** Impact per unit of effort, computed by `bugHuntScore` — never taken from the model. */
  score: v.number(),
  confidence: bugHuntConfidenceSchema,
  /** One or two sentences on why this ratio — the reason a human can argue with. */
  rationale: v.string(),
  /** Whether the model would actually pick this one up now. */
  recommended: v.boolean(),
})
export type BugHuntAnalysis = v.InferOutput<typeof bugHuntAnalysisSchema>

/**
 * One open bug read off a tracker board — the FACTS, all of them provider-supplied. Richer
 * than a `TaskSearchResult` (which is deliberately lean for a picker row) but still bounded:
 * a provider gathers the whole candidate set in ONE vendor call, so a 40-candidate hunt costs
 * one request, and `description` is truncated because the ranking only needs enough of the
 * report to judge impact and effort.
 */
export const bugCandidateSchema = v.object({
  source: taskSourceKindSchema,
  /** The source's canonical key for the issue (a valid import ref). */
  externalId: v.string(),
  title: v.string(),
  url: v.string(),
  /** Workflow status name (may be empty). */
  status: v.string(),
  /** Issue type name (may be empty for sources with no type notion). */
  type: v.string(),
  /** Priority name, or null when the source records none. */
  priority: v.nullable(v.string()),
  labels: v.array(v.string()),
  /** A truncated excerpt of the issue body (may be empty). */
  description: v.string(),
  /** ISO-8601 creation timestamp (empty when the source doesn't report one). */
  createdAt: v.string(),
  /** How many comments the issue has accumulated — a cheap proxy for how contested it is. */
  commentCount: v.number(),
})
export type BugCandidate = v.InferOutput<typeof bugCandidateSchema>

/**
 * One ranked candidate: the tracker facts plus the model's assessment, kept as separate
 * halves on purpose. `analysis` is null for a candidate the ranking didn't cover — either the
 * whole analysis was unavailable, or the model silently dropped that row. A missing
 * assessment must read as "not assessed", never as a zero score.
 */
export const bugHuntCandidateSchema = v.object({
  ...bugCandidateSchema.entries,
  analysis: v.nullable(bugHuntAnalysisSchema),
})
export type BugHuntCandidate = v.InferOutput<typeof bugHuntCandidateSchema>

/** Why a hunt came back without a ranking, so the UI states the limitation instead of implying one. */
export const bugHuntAnalysisStatusSchema = v.picklist([
  /** The model ranked the candidates. */
  'ranked',
  /** No ranking model is wired on this deployment. */
  'unavailable',
  /** A model is wired but the assessment failed; the candidates are returned unranked. */
  'failed',
  /**
   * The workspace is over its spend budget, so the billable ranking call was not made. Distinct
   * from `failed` because nothing is broken and the fix is a budget, not a credential.
   */
  'over_budget',
  /** Nothing to rank (the board had no matching open unassigned bugs). */
  'empty',
])
export type BugHuntAnalysisStatus = v.InferOutput<typeof bugHuntAnalysisStatusSchema>

export const bugHuntResultSchema = v.object({
  source: taskSourceKindSchema,
  /**
   * The board the hunt ran against, echoed back so a stale response is recognisable. For a
   * repo-backed source it also names the RESOLVED repository to the person reading the shortlist,
   * rather than leaving that to be inferred from which service they opened the hunt on.
   */
  board: v.string(),
  analysisStatus: bugHuntAnalysisStatusSchema,
  /** `provider:model` that produced the ranking, or null when there was none. */
  model: v.nullable(v.string()),
  /** Candidates, best-scoring first; unassessed ones sort last. */
  candidates: v.array(bugHuntCandidateSchema),
  /**
   * How many open unassigned bugs this hunt considered — the board search's result, bounded by
   * the scan cap. It is what the truncation notice counts, so it is reported rather than left
   * to be inferred from `candidates`.
   */
  scanned: v.number(),
  /**
   * Whether the board holds MORE matching bugs than the cap allowed in (detected by scanning one
   * past it), so the list is a prefix rather than the whole board. Said out loud because a
   * silently shortened list reads exactly like an exhaustive one.
   */
  truncated: v.boolean(),
})
export type BugHuntResult = v.InferOutput<typeof bugHuntResultSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Run a hunt over one board's open, unassigned bugs. The predicates default to the tracker's
 * own bug convention (issue type `bug`) and are narrowable per hunt.
 */
export const runBugHuntSchema = v.object({
  /**
   * The service frame (or a module under one) the hunt runs for: where an adopted candidate
   * lands, and (for a REPO-BACKED source) what FIXES the board, since every issue of such a
   * source belongs to one repository and the one this hunt may read is the service's own.
   */
  containerId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /**
   * The board to scan, as the vendor-shaped id from {@link trackerBoardSchema} (or typed in by
   * hand for a source whose boards can't be listed).
   *
   * A REQUIRED key carrying a NULLABLE value, the same shape (and for the same reason) as the
   * repo scope a search hands a provider: `null` means "this source has no board to name",
   * which is the only legal value for a repo-backed one, whose board is resolved from
   * `containerId`'s service instead. Naming one there is REFUSED rather than ignored, because a
   * caller that believes it scoped a hunt somewhere must not be answered with a scan of somewhere
   * else. Omitting one for a repo-LESS source is refused too, because an unscoped vendor issue
   * search reaches everything the credential can see.
   */
  board: v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** Issue type to hunt; omitted → `bug`. Sources without a type notion ignore it. */
  issueType: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60))),
  /** Labels that must ALL be present. */
  labels: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)))),
  /** Substring that must appear in the issue title. */
  titleFragment: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
})
export type RunBugHuntInput = v.InferOutput<typeof runBugHuntSchema>

/**
 * Adopt a confirmed candidate: import the issue, create a `bug` task from it inside
 * `containerId`, link the issue for agent context, and start the bug-fix pipeline.
 */
export const adoptBugHuntCandidateSchema = v.object({
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** The service frame or module the new task is created in. */
  containerId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The pipeline to run; omitted → the built-in bug-fix pipeline. */
  pipelineId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
})
export type AdoptBugHuntCandidateInput = v.InferOutput<typeof adoptBugHuntCandidateSchema>
