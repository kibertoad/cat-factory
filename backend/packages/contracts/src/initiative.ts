import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Initiative wire contracts. An Initiative is the longer-running counterpart to
// a task: a multi-phase body of work (a cross-cutting refactor, a migration, a
// strangler conversion) planned once by the Initiative Planning pipeline and
// then executed as a loop of ordinary tasks until every item is resolved.
//
// The DB row (the `initiatives` table, one per initiative-level block) is the
// SOURCE OF TRUTH: the execution loop needs transactional state (a `rev` CAS
// token, item↔block mapping) that a Git file cannot provide. The committed
// in-repo tracker (`docs/initiatives/<slug>/…`) is a deterministic, rendered
// PROJECTION of this entity — the blueprint artifact pattern — so the plan
// travels with the code and stays human-readable.
//
// Items carry planner-authored estimates (the task-estimator axes) so the loop
// can pick each spawned task's pipeline by matching the estimate against the
// initiative's ordered pipeline rules (OR across axes — `StepGating` semantics).
// ---------------------------------------------------------------------------

// Field length/value bounds, exported as named constants so the lenient coercion in
// `@cat-factory/agents` (`coerceInitiativePlan`) clamps to the SAME limits this strict schema
// enforces — a single source of truth, so bumping a bound here can't leave the coercion
// silently truncating to a stale value (or emitting a plan the parser then rejects).
export const INITIATIVE_ID_MAX = 80
export const INITIATIVE_TITLE_MAX = 200
export const INITIATIVE_PROSE_MAX = 8000
export const INITIATIVE_SHORT_MAX = 2000
export const INITIATIVE_MAX_CONCURRENT = 20

const score = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const idField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(INITIATIVE_ID_MAX))
const titleField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(INITIATIVE_TITLE_MAX))
const proseField = v.pipe(v.string(), v.maxLength(INITIATIVE_PROSE_MAX))
const shortProseField = v.pipe(v.string(), v.maxLength(INITIATIVE_SHORT_MAX))

/** Lifecycle of a single tracker item (one unit of work → one spawned task). */
export const initiativeItemStatusSchema = v.picklist([
  'pending',
  'in_progress',
  'pr_open',
  'done',
  'blocked',
  'skipped',
])
export type InitiativeItemStatus = v.InferOutput<typeof initiativeItemStatusSchema>

/** Lifecycle of the initiative as a whole. */
export const initiativeStatusSchema = v.picklist([
  'planning',
  'awaiting_approval',
  'executing',
  'paused',
  'done',
  'cancelled',
])
export type InitiativeStatus = v.InferOutput<typeof initiativeStatusSchema>

/**
 * A planner-authored triage of one item on the task-estimator axes. Stamped onto
 * the spawned block's `estimate` (with `createdAt`/`model` added) so downstream
 * estimate-gated steps see it, and matched against the initiative's pipeline
 * rules to pick the task's pipeline.
 */
export const initiativeEstimateSchema = v.object({
  complexity: score,
  risk: score,
  impact: score,
  rationale: v.optional(shortProseField, ''),
})
export type InitiativeEstimate = v.InferOutput<typeof initiativeEstimateSchema>

/**
 * One ordered pipeline-selection rule: the item's estimate matches when ANY
 * supplied axis is met or exceeded (OR across axes — the `StepGating` semantics
 * of `shouldRunGatedStep`). First matching rule wins; no match falls through to
 * the policy's `defaultPipelineId`. A rule with no thresholds never matches.
 */
export const initiativePipelineRuleSchema = v.object({
  pipelineId: idField,
  minComplexity: v.optional(score),
  minRisk: v.optional(score),
  minImpact: v.optional(score),
})
export type InitiativePipelineRule = v.InferOutput<typeof initiativePipelineRuleSchema>

/**
 * How the execution loop runs the plan: how many tasks may be in flight at once,
 * and which pipeline each spawned task gets. Agreed during planning.
 */
export const initiativeExecutionPolicySchema = v.object({
  /** Max concurrently-running spawned tasks across the whole initiative. */
  maxConcurrent: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(INITIATIVE_MAX_CONCURRENT),
  ),
  /** Ordered estimate→pipeline rules; first match wins. */
  rules: v.optional(v.array(initiativePipelineRuleSchema), []),
  /** Pipeline used when no rule matches (or the item carries no estimate). */
  defaultPipelineId: idField,
  /**
   * What to do when an item has NO estimate: `default` uses `defaultPipelineId`;
   * `strongest` uses the last rule's pipeline (rules are ordered weakest-first),
   * fail-safe to thoroughness.
   */
  onMissingEstimate: v.optional(v.picklist(['default', 'strongest']), 'default'),
})
export type InitiativeExecutionPolicy = v.InferOutput<typeof initiativeExecutionPolicySchema>

/** One phase of the plan. Array order IS the phase order; phases run sequentially. */
export const initiativePhaseSchema = v.object({
  id: idField,
  title: titleField,
  /** What this phase achieves — shown on the tracker, not fed to agents. */
  goal: v.optional(shortProseField, ''),
  /** Optional tighter concurrency cap for this phase alone. */
  maxConcurrent: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(INITIATIVE_MAX_CONCURRENT)),
  ),
})
export type InitiativePhase = v.InferOutput<typeof initiativePhaseSchema>

/** One unit of work in the tracker — spawned just-in-time as a task block. */
export const initiativeItemSchema = v.object({
  id: idField,
  /** The owning phase (must reference a `phases[].id`). */
  phaseId: idField,
  title: titleField,
  /** The spawned task's description — written to be self-sufficient. */
  description: proseField,
  /** Intra-initiative item ids that must be `done` before this item may start. */
  dependsOn: v.optional(v.array(idField), []),
  /** Planner-authored estimate driving pipeline selection (absent ⇒ policy fallback). */
  estimate: v.optional(initiativeEstimateSchema),
  /** Explicit pipeline override; absent ⇒ the policy's rules decide. */
  pipelineId: v.optional(idField),
  status: initiativeItemStatusSchema,
  /** Id of the task block the loop spawned for this item; null until spawned. */
  blockId: v.optional(v.nullable(v.string())),
  /** The item's pull request, copied from the spawned block at settlement. */
  pr: v.optional(v.object({ url: v.string(), number: v.optional(v.number()) })),
  /** Loop/human annotation — e.g. the failure detail that blocked the item. */
  note: v.optional(shortProseField),
})
export type InitiativeItem = v.InferOutput<typeof initiativeItemSchema>

/** A decision recorded on the tracker (made during planning or mid-flight). */
export const initiativeDecisionSchema = v.object({
  id: idField,
  at: v.number(),
  title: titleField,
  detail: v.optional(shortProseField, ''),
  source: v.picklist(['planning', 'human', 'agent']),
})
export type InitiativeDecision = v.InferOutput<typeof initiativeDecisionSchema>

/** A deviation from the plan discovered mid-flight (e.g. a failed item's cause). */
export const initiativeDeviationSchema = v.object({
  id: idField,
  at: v.number(),
  /** The item the deviation relates to; null for initiative-wide deviations. */
  itemId: v.optional(v.nullable(idField)),
  description: shortProseField,
  resolution: v.optional(shortProseField),
})
export type InitiativeDeviation = v.InferOutput<typeof initiativeDeviationSchema>

/** A follow-up surfaced during execution, awaiting triage into a real item. */
export const initiativeFollowUpSchema = v.object({
  id: idField,
  at: v.number(),
  /** The item whose run surfaced this follow-up; null when raised by a human. */
  sourceItemId: v.optional(v.nullable(idField)),
  title: titleField,
  detail: v.optional(shortProseField, ''),
  status: v.picklist(['open', 'promoted', 'dismissed']),
  /** The item this follow-up was promoted into, once `promoted`. */
  promotedItemId: v.optional(idField),
})
export type InitiativeFollowUp = v.InferOutput<typeof initiativeFollowUpSchema>

/**
 * A single planning-interview exchange, kept as a bounded digest on the tracker AND the
 * live state of the interactive interview: the interviewer appends a question with an empty
 * `answer` (a PENDING question the human must answer) and the human fills it in. A stable
 * `id` addresses the answer write; it is optional only so hand-authored/fixture Q&A without
 * one still parses (the interviewer always sets it).
 */
export const initiativeQaSchema = v.object({
  id: v.optional(idField),
  question: shortProseField,
  answer: v.optional(shortProseField, ''),
})
export type InitiativeQa = v.InferOutput<typeof initiativeQaSchema>

/**
 * Live state of the interactive planning interview (slice 2). Absent until the interviewer
 * runs. `round` counts reviewer passes (the interviewer may ask follow-ups after seeing
 * answers, up to `maxRounds`); `status` is `awaiting` while the run is parked for the human
 * and `done` once the interview converged (or the human proceeded) and the goal/constraints
 * brief was synthesized onto the entity.
 */
export const initiativeInterviewStateSchema = v.object({
  round: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxRounds: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: v.picklist(['awaiting', 'done']),
})
export type InitiativeInterviewState = v.InferOutput<typeof initiativeInterviewStateSchema>

/**
 * The persisted initiative entity — the DB source of truth the loop mutates and
 * the snapshot carries. `rev` is the optimistic-concurrency token: every write
 * goes through a compare-and-swap on it, making the execution loop a single
 * writer by construction. The current phase is DERIVED (the first phase with a
 * non-`done`/non-`skipped` item), never stored.
 */
export const initiativeSchema = v.object({
  id: v.string(),
  /** The initiative-level board block this entity belongs to (1:1). */
  blockId: v.string(),
  /** Stable slug naming the in-repo tracker folder (`docs/initiatives/<slug>/`). */
  slug: idField,
  title: titleField,
  /** The agreed goal statement (from planning). */
  goal: v.optional(proseField, ''),
  constraints: v.optional(v.array(shortProseField), []),
  nonGoals: v.optional(v.array(shortProseField), []),
  /** Bounded digest of the planning interview (and the live pending questions while it runs). */
  qa: v.optional(v.array(initiativeQaSchema), []),
  /** Live state of the interactive planning interview; absent until the interviewer runs. */
  interview: v.optional(v.nullable(initiativeInterviewStateSchema)),
  /** Bounded summary of the codebase analysis that informed the plan. */
  analysisSummary: v.optional(proseField, ''),
  phases: v.optional(v.array(initiativePhaseSchema), []),
  items: v.optional(v.array(initiativeItemSchema), []),
  policy: v.optional(v.nullable(initiativeExecutionPolicySchema)),
  decisions: v.optional(v.array(initiativeDecisionSchema), []),
  deviations: v.optional(v.array(initiativeDeviationSchema), []),
  followUps: v.optional(v.array(initiativeFollowUpSchema), []),
  caveats: v.optional(v.array(shortProseField), []),
  status: initiativeStatusSchema,
  /**
   * Repo-mirror bookkeeping: the last committed tracker version + content hash
   * (see {@link initiativeVersionSchema}). Absent until the first commit, or
   * forever on a GitHub-unwired workspace — render from the entity, never assume
   * the mirror exists.
   */
  doc: v.optional(v.object({ version: v.number(), hash: v.string(), committedAt: v.number() })),
  /** Optimistic-concurrency token; bumped on every successful write. */
  rev: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type Initiative = v.InferOutput<typeof initiativeSchema>

// ---- Planner output (the plan draft) ---------------------------------------

/** A draft item as the planner emits it — no runtime fields yet. */
export const initiativeDraftItemSchema = v.object({
  id: v.optional(idField),
  phaseId: idField,
  title: titleField,
  description: v.optional(proseField, ''),
  dependsOn: v.optional(v.array(idField), []),
  estimate: v.optional(initiativeEstimateSchema),
  pipelineId: v.optional(idField),
})
export type InitiativeDraftItem = v.InferOutput<typeof initiativeDraftItemSchema>

/**
 * The `initiative-planner` agent's structured output: the multi-phase plan minus
 * all runtime state. Ingest turns it into the persisted entity (`applyPlanDraft`),
 * assigning deterministic ids where the draft omitted them and stamping every
 * item `pending`.
 */
export const initiativePlanDraftSchema = v.object({
  goal: v.optional(proseField, ''),
  constraints: v.optional(v.array(shortProseField), []),
  nonGoals: v.optional(v.array(shortProseField), []),
  analysisSummary: v.optional(proseField, ''),
  phases: v.array(
    v.object({
      id: v.optional(idField),
      title: titleField,
      goal: v.optional(shortProseField, ''),
      maxConcurrent: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(INITIATIVE_MAX_CONCURRENT)),
      ),
    }),
  ),
  items: v.array(initiativeDraftItemSchema),
  policy: initiativeExecutionPolicySchema,
  decisions: v.optional(
    v.array(v.object({ title: titleField, detail: v.optional(shortProseField, '') })),
    [],
  ),
  caveats: v.optional(v.array(shortProseField), []),
})
export type InitiativePlanDraft = v.InferOutput<typeof initiativePlanDraftSchema>

// ---- Request bodies ---------------------------------------------------------

/** Create an initiative block (+ its empty entity) under a service frame. */
export const createInitiativeSchema = v.object({
  frameId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  title: titleField,
  description: v.optional(proseField, ''),
})
export type CreateInitiativeInput = v.InferOutput<typeof createInitiativeSchema>

/** Record the human's answer to one pending planning-interview question. */
export const answerInitiativeQuestionSchema = v.object({
  questionId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  answer: shortProseField,
})
export type AnswerInitiativeQuestionInput = v.InferOutput<typeof answerInitiativeQuestionSchema>

// ---- In-repo tracker artifact ----------------------------------------------
// The loop mirrors the entity into the target repo so the plan travels with the
// code, following the blueprint artifact pattern: a canonical JSON file, a
// deterministic human-readable markdown rendering, and a tiny version manifest
// for cheap staleness checks.

/** Folder, relative to the repo root, that holds all initiative trackers. */
export const INITIATIVE_DOC_DIR = 'docs/initiatives'
/** Folder for one initiative's tracker files. */
export function initiativeDocDir(slug: string): string {
  return `${INITIATIVE_DOC_DIR}/${slug}`
}
/**
 * Canonical machine-readable tracker file. This is a CONTENT PROJECTION of the entity, NOT a
 * full `Initiative`: the volatile bookkeeping (`rev`, `updatedAt`, `doc`) is deliberately
 * excluded so its content hash stays stable across no-op DB writes (see
 * `initiativeContentView`/`canonicalInitiativeJson` in `@cat-factory/agents`). Do NOT feed it
 * back through `parseInitiative` — those required fields are absent by design; the DB row, not
 * this file, is the source of truth for the runtime state.
 */
export function initiativeJsonPath(slug: string): string {
  return `${initiativeDocDir(slug)}/initiative.json`
}
/** Human-readable tracker rendering (the CLAUDE.md tracker-document convention). */
export function initiativeTrackerPath(slug: string): string {
  return `${initiativeDocDir(slug)}/tracker.md`
}
/** Tiny manifest read for quick staleness checks without parsing the full entity. */
export function initiativeVersionPath(slug: string): string {
  return `${initiativeDocDir(slug)}/version.json`
}

/** The lightweight `version.json` manifest committed alongside the tracker. */
export const initiativeVersionSchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  generatedAt: v.string(),
  /** sha256 (hex) of the canonical `initiative.json` bytes. */
  hash: v.string(),
  items: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type InitiativeVersion = v.InferOutput<typeof initiativeVersionSchema>

/**
 * Strictly parse an arbitrary value into an {@link Initiative}, enforcing the
 * exact schema shape. **Throws** on any violation — use at every trust boundary
 * (reading `initiative.json`, ingesting a stored row).
 */
export function parseInitiative(value: unknown): Initiative {
  return v.parse(initiativeSchema, value)
}

/** Non-throwing variant: returns the parsed initiative or `undefined` when invalid. */
export function safeParseInitiative(value: unknown): Initiative | undefined {
  const result = v.safeParse(initiativeSchema, value)
  return result.success ? result.output : undefined
}

/**
 * The persisted-row shape both facades store an initiative as: the entity as a JSON
 * `doc` blob plus the loop-relevant keys lifted into their own columns (the CAS
 * predicate runs on the `rev` COLUMN, so the columns — not the blob — are authoritative).
 */
export interface InitiativeRowLike {
  id: string
  block_id: string
  slug: string
  status: string
  rev: number
  doc: string
  created_at: number
  updated_at: number
}

/**
 * Decode a stored row into the entity, re-imposing the column-lifted keys over the
 * `doc` blob (a corrupt/unparseable row ⇒ null, so a list read can drop it rather than
 * fail the whole board load). Shared by the D1 and Drizzle repositories so the
 * column↔field contract lives in exactly one place and the runtimes can't drift.
 */
export function decodeInitiativeRow(row: InitiativeRowLike): Initiative | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.doc)
  } catch {
    return null
  }
  return (
    safeParseInitiative({
      ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
      id: row.id,
      blockId: row.block_id,
      slug: row.slug,
      status: row.status,
      rev: row.rev,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }) ?? null
  )
}

/** Strictly parse a planner plan draft. Throws on shape violations. */
export function parseInitiativePlanDraft(value: unknown): InitiativePlanDraft {
  return v.parse(initiativePlanDraftSchema, value)
}

/** Item statuses that count as settled (nothing left for the loop to drive). */
export const INITIATIVE_ITEM_TERMINAL_STATUSES: ReadonlySet<InitiativeItemStatus> = new Set([
  'done',
  'skipped',
])
