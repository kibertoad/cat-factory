import * as v from 'valibot'
import { createTaskTypeSchema, taskTypeFieldsSchema } from './primitives.js'
import { agentConfigValuesSchema } from './agent-config.js'
import {
  DESCRIPTOR_FIELD_ARRAY_MAX,
  DESCRIPTOR_FIELD_VALUE_MAX,
  descriptorFieldValueSchema,
  descriptorFieldValuesSchema,
  type DescriptorFieldValue,
  type DescriptorFieldValues,
} from './form-fields.js'

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
// The tracker-folder slug feeds `initiativeDocDir(slug)` = `docs/initiatives/<slug>` and the
// JSON/tracker/version paths committed via `RepoFiles.commitFiles`, so it must stay a plain
// lower-kebab token — no dots or slashes that could reshape a committed path. The server only
// ever produces such slugs (`initiativeSlug`), so this constrains the wire contract to what the
// generator already guarantees. Distinct from `idField` (used for pipeline/phase/item ids like
// `pl_full`, which legitimately carry underscores).
const slugField = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(INITIATIVE_ID_MAX),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
)
const titleField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(INITIATIVE_TITLE_MAX))
const proseField = v.pipe(v.string(), v.maxLength(INITIATIVE_PROSE_MAX))
const shortProseField = v.pipe(v.string(), v.maxLength(INITIATIVE_SHORT_MAX))

// ---------------------------------------------------------------------------
// Initiative-preset inputs. A preset (see `initiative-preset.ts`) bundles a
// backend-supplied FORM the user fills at create time; the filled values are a
// bounded JSON record, persisted on the entity (`presetInputs`) and FROZEN after
// create. The shape itself is the SHARED descriptor-form value bag (`form-fields.ts`,
// the vocabulary a custom task type's per-case form also fills); these are the
// preset-named aliases, kept here beside the entity that persists them.
// ---------------------------------------------------------------------------

/** Bound on a single string / string-array element value in {@link initiativePresetInputsSchema}. */
export const INITIATIVE_PRESET_INPUT_MAX = DESCRIPTOR_FIELD_VALUE_MAX
/** Bound on the number of elements in a `checkbox-group`/multi-value input. */
export const INITIATIVE_PRESET_INPUT_ARRAY_MAX = DESCRIPTOR_FIELD_ARRAY_MAX

/**
 * One filled preset-form value: a scalar (`text`/`select`/`path`/…), a multi-select, a toggle, or a
 * number. The shared descriptor-form value shape ({@link descriptorFieldValueSchema}) under the
 * preset's own name, so this entity keeps referencing the vocabulary it persists.
 */
export const initiativePresetInputValueSchema = descriptorFieldValueSchema
export type InitiativePresetInputValue = DescriptorFieldValue

/** The user's filled preset form: a bounded map from field `key` to its value. */
export const initiativePresetInputsSchema = descriptorFieldValuesSchema
export type InitiativePresetInputs = DescriptorFieldValues

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
  /**
   * When true, the initiative PAUSES for human review once every item in this phase settles, before
   * the next phase spawns (the D2 checkpoint — e.g. read a phase's committed research/verdict, then
   * resume to continue or cancel). Stamped at ingest from a preset's phase template (the planner
   * cannot unset a template-authored checkpoint), or authored directly by the planner on a draft
   * phase (generic — usable without a preset). Absent ⇒ the phase advances unattended.
   */
  checkpoint: v.optional(v.boolean()),
  /**
   * Wall-clock ms when a human CLEARED this phase's checkpoint (stamped by `resume`). Absent ⇒ not
   * yet cleared. A cleared checkpoint never re-fires, so the loop advances past a reviewed phase.
   * Loop/entity bookkeeping — never planner- or template-authored; preserved across a re-plan/replay.
   */
  checkpointClearedAt: v.optional(v.number()),
})
export type InitiativePhase = v.InferOutput<typeof initiativePhaseSchema>

/**
 * Preset-authored decoration for a spawned task, folded onto the task block by the
 * execution loop's `buildTaskBlock` (slice 5) so an item comes out as a first-class typed
 * task rather than a bare description block. Every field is optional and additive:
 *   - `taskType`       — the kind of work (`document`/`bug`/`spike`/…), so a spawned doc task
 *                        classifies exactly like one created on the board (`taskType`-keyed
 *                        per-type task limits + the SPA's document affordances). Absent ⇒ the
 *                        block stays untyped (`feature`), byte-identical to the pre-slice-5 shape.
 *   - `taskTypeFields` — the per-type block fields (a doc task's `targetPath`/`docKind`, …).
 *   - `fragmentIds`    — best-practice prompt fragments to stamp on the block.
 *   - `agentConfig`    — per-agent-kind config values for the spawned pipeline.
 *   - `gates`          — a per-run gate override (parallel to the pipeline's steps, one
 *                        boolean each), threaded through the slice-2 gate-override seam.
 * Emitted by the planner (via the draft item) and/or enforced by a preset's `seedPlan`.
 */
export const initiativeItemSpawnSchema = v.object({
  taskType: v.optional(createTaskTypeSchema),
  taskTypeFields: v.optional(taskTypeFieldsSchema),
  fragmentIds: v.optional(v.array(v.string())),
  agentConfig: v.optional(agentConfigValuesSchema),
  gates: v.optional(v.array(v.boolean())),
})
export type InitiativeItemSpawn = v.InferOutput<typeof initiativeItemSpawnSchema>

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
  /** Preset-authored spawn decoration stamped onto the spawned task block (slice 5). */
  spawn: v.optional(initiativeItemSpawnSchema),
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
 * Lifecycle of one planning-interview question — the initiative half of the shared
 * "clarification item" vocabulary (see `docs/initiatives/clarification-items.md`), mirroring the
 * requirements-review item statuses the planning window reuses. `open` = awaiting an answer;
 * `dismissed` = the stakeholder marked it not relevant (it no longer blocks continue/proceed and
 * the interviewer is told not to re-ask). "Answered" is DERIVED from a non-empty `answer` (not a
 * stored status), so the interviewer's answered-digest logic stays unchanged.
 */
export const initiativeQaStatusSchema = v.picklist(['open', 'dismissed'])
export type InitiativeQaStatus = v.InferOutput<typeof initiativeQaStatusSchema>

/**
 * A single planning-interview exchange, kept as a bounded digest on the tracker AND the
 * live state of the interactive interview: the interviewer appends a question with an empty
 * `answer` (a PENDING question the human must answer) and the human fills it in. A stable
 * `id` addresses the answer write; it is optional only so hand-authored/fixture Q&A without
 * one still parses (the interviewer always sets it).
 *
 * `status`/`recommendation` back the shared clarification surface the planning window borrows
 * from requirements review: a question can be marked `dismissed` ("not relevant"), and the human
 * can ask the interviewer to `recommend` a suggested answer (stored here, offered as "use this").
 * Both default to the pre-existing shape, so older rows / fixtures parse unchanged.
 */
export const initiativeQaSchema = v.object({
  id: v.optional(idField),
  question: shortProseField,
  answer: v.optional(shortProseField, ''),
  /** `open` (default) or `dismissed`. Answered-ness is derived from a non-empty `answer`. */
  status: v.optional(initiativeQaStatusSchema, 'open'),
  /** An AI-suggested answer the human can adopt/edit, or null; set by the recommend action. */
  recommendation: v.optional(v.nullable(shortProseField)),
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
  slug: slugField,
  title: titleField,
  /**
   * The initiative-preset this initiative was created from (see `initiative-preset.ts`).
   * Absent ⇒ a preset-less initiative created by an old client / the public API — its
   * behaviour is byte-for-byte today's (the generic pipeline, human review on). The SPA
   * picker seeds `preset_generic` for new initiatives, but a preset only ever ADDS context;
   * nothing in the planning/loop path branches on its presence.
   */
  presetId: v.optional(idField),
  /** The user's filled preset form, FROZEN at create (the `agentConfig` freeze precedent). */
  presetInputs: v.optional(initiativePresetInputsSchema),
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
  /** Preset-authored spawn decoration (a `seedPlan` may enforce/override it at ingest). */
  spawn: v.optional(initiativeItemSpawnSchema),
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
      /**
       * Planner-authored checkpoint request (see {@link initiativePhaseSchema}'s `checkpoint`). A
       * preset's phase template can FORCE it on at ingest; the planner cannot unset a template one.
       */
      checkpoint: v.optional(v.boolean()),
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
  /**
   * The initiative PRESET this initiative is created from (see `initiative-preset.ts`). Absent ⇒
   * the preset-less generic behaviour, byte-for-byte today's (the SPA picker sends
   * `preset_generic` by default). An unknown id is a validation error; the descriptor validates
   * {@link presetInputs} at create.
   */
  presetId: v.optional(idField),
  /**
   * The user's filled preset form. Validated against the resolved descriptor at create
   * ({@link validateInitiativePresetInputs}) and FROZEN on the entity's `presetInputs`.
   */
  presetInputs: v.optional(initiativePresetInputsSchema),
})
export type CreateInitiativeInput = v.InferOutput<typeof createInitiativeSchema>

/**
 * Probe a preset's repo-detection PREFILL for a service frame. Resolves the frame's repo and
 * runs the preset's `detect` hook over it, returning the detected form values. Best-effort: the
 * endpoint returns `{}` (descriptor defaults) whenever GitHub is unwired, the frame has no linked
 * repo, or the preset has no `detect` hook — it never blocks create.
 */
export const probeInitiativePresetSchema = v.object({
  /** The service frame whose repo the probe reads. */
  frameId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type ProbeInitiativePresetInput = v.InferOutput<typeof probeInitiativePresetSchema>

/** Record the human's answer to one pending planning-interview question. */
export const answerInitiativeQuestionSchema = v.object({
  questionId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  answer: shortProseField,
})
export type AnswerInitiativeQuestionInput = v.InferOutput<typeof answerInitiativeQuestionSchema>

/** Mark a planning-interview question not-relevant (`dismissed`) or reopen it (`open`). */
export const setInitiativeQuestionStatusSchema = v.object({
  questionId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  status: initiativeQaStatusSchema,
})
export type SetInitiativeQuestionStatusInput = v.InferOutput<
  typeof setInitiativeQuestionStatusSchema
>

/** Ask the interviewer to recommend a suggested answer for one pending planning question. */
export const recommendInitiativeAnswerSchema = v.object({
  questionId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type RecommendInitiativeAnswerInput = v.InferOutput<typeof recommendInitiativeAnswerSchema>

// ---- Follow-up triage + item/policy editing (slice 4) ----------------------
// Mid-flight human curation of an executing initiative. A follow-up harvested from a spawned
// task's run (see `initiativeFollowUpSchema`) is either PROMOTED into a real tracker item (a
// new `pending` item the loop then spawns) or DISMISSED. Items and the execution policy can
// also be edited directly (retry/skip a stuck item, retitle/re-scope a not-yet-started one,
// retune concurrency + pipeline rules). Every write goes through the same rev-CAS single-writer
// path as the loop, so a human edit and a live tick can't clobber each other.

/**
 * Promote an `open` follow-up into a real tracker item: appends a new `pending` item to the
 * named phase (spawned by the loop like any other), and flips the follow-up `promoted` with a
 * `promotedItemId` back-reference. Title/description default to the follow-up's when omitted.
 */
export const promoteInitiativeFollowUpSchema = v.object({
  /** The phase the new item belongs to (must reference an existing `phases[].id`). */
  phaseId: idField,
  /** Item title; defaults to the follow-up's title when omitted. */
  title: v.optional(titleField),
  /** Item description; defaults to the follow-up's detail when omitted. */
  description: v.optional(proseField),
  /** Planner-style estimate driving pipeline selection (absent ⇒ policy fallback). */
  estimate: v.optional(initiativeEstimateSchema),
  /** Explicit pipeline override; absent ⇒ the policy's rules decide. */
  pipelineId: v.optional(idField),
  /** Intra-initiative item ids that must be `done`/`skipped` before this item may start. */
  dependsOn: v.optional(v.array(idField)),
})
export type PromoteInitiativeFollowUpInput = v.InferOutput<typeof promoteInitiativeFollowUpSchema>

/**
 * Edit one tracker item and/or drive its status. Content edits (`title`/`description`/
 * `estimate`/`pipelineId`/`dependsOn`) apply only to a not-yet-settled item that is not in
 * flight (`pending`/`blocked`) — an in-flight/settled item's spawned task already carries its
 * own copy. `action` unsticks a halted phase: `retry` returns a `blocked` item to `pending`
 * (the next sweep re-spawns it), `skip` settles it `skipped`.
 */
export const updateInitiativeItemSchema = v.object({
  title: v.optional(titleField),
  description: v.optional(proseField),
  estimate: v.optional(initiativeEstimateSchema),
  pipelineId: v.optional(idField),
  dependsOn: v.optional(v.array(idField)),
  action: v.optional(v.picklist(['retry', 'skip'])),
})
export type UpdateInitiativeItemInput = v.InferOutput<typeof updateInitiativeItemSchema>

/** Replace an executing initiative's execution policy (concurrency + pipeline rules). */
export const updateInitiativePolicySchema = initiativeExecutionPolicySchema
export type UpdateInitiativePolicyInput = v.InferOutput<typeof updateInitiativePolicySchema>

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

/**
 * Strictly parse a planner plan draft. Throws on shape violations.
 *
 * There is deliberately NO non-throwing variant: the only consumer is the ingest, whose
 * whole job is to reject a malformed plan loudly. The review rendering does not parse the
 * planner's raw output at all — it renders the INGESTED entity (see
 * {@link renderInitiativePlanForReview}), so a second, more lenient reading of the same
 * bytes can never disagree with what was committed.
 */
export function parseInitiativePlanDraft(value: unknown): InitiativePlanDraft {
  return v.parse(initiativePlanDraftSchema, value)
}

/**
 * What {@link renderInitiativePlanForReview} reads — the plan-shaped intersection of the
 * planner's {@link InitiativePlanDraft} and the ingested {@link Initiative}, so one renderer
 * serves both without either type having to know about it.
 *
 * It exists because the two are NOT interchangeable in the one place that matters: the human
 * gate reviews the plan that will EXECUTE, which is the entity — the draft has not yet been
 * through the preset's phase-template reorder, its `seedPlan` decoration, or the carry-over of
 * items a previous plan already materialised. The renderer is therefore written against the
 * shape both satisfy, and its callers choose the truthful one (see the `initiative-planner`
 * step resolver). Every field is read-only and optional-tolerant: the entity's `policy` is
 * nullable and its items carry runtime `status`, neither of which a draft has.
 */
export interface InitiativePlanView {
  goal?: string
  constraints?: readonly string[]
  nonGoals?: readonly string[]
  analysisSummary?: string
  phases?: readonly {
    id?: string
    title: string
    goal?: string
    maxConcurrent?: number
    checkpoint?: boolean
  }[]
  items?: readonly {
    id?: string
    phaseId: string
    title: string
    description?: string
    dependsOn?: readonly string[]
    estimate?: InitiativeEstimate
    pipelineId?: string
    status?: InitiativeItemStatus
  }[]
  policy?: InitiativeExecutionPolicy | null
  decisions?: readonly { title: string; detail?: string }[]
  caveats?: readonly string[]
}

/** One estimate axis rendered as a percentage, so the three read comparably. */
function estimatePct(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** The axes a pipeline rule matches on, as prose ('never' when it declares none). */
function renderRuleAxes(rule: InitiativePipelineRule): string {
  const axes = [
    rule.minComplexity !== undefined ? `complexity ≥ ${estimatePct(rule.minComplexity)}` : null,
    rule.minRisk !== undefined ? `risk ≥ ${estimatePct(rule.minRisk)}` : null,
    rule.minImpact !== undefined ? `impact ≥ ${estimatePct(rule.minImpact)}` : null,
  ].filter((axis): axis is string => axis !== null)
  return axes.length ? axes.join(' or ') : 'never matches (no thresholds declared)'
}

/** One item's body, under a heading the outline turns into its own navigable section. */
function renderPlanItem(item: NonNullable<InitiativePlanView['items']>[number]): string[] {
  const lines: string[] = ['', `### ${item.title}${item.id ? ` (${item.id})` : ''}`]
  if (item.description) lines.push('', item.description)
  // Only a NON-pending status is worth a line: it means the item is already underway or
  // settled, which is how a re-plan's carried-over items differ from the ones being proposed.
  if (item.status && item.status !== 'pending') lines.push('', `Status: \`${item.status}\`.`)
  const estimate = item.estimate
  if (estimate) {
    lines.push(
      '',
      `- Complexity: ${estimatePct(estimate.complexity)}`,
      `- Risk: ${estimatePct(estimate.risk)}`,
      `- Impact: ${estimatePct(estimate.impact)}`,
    )
    if (estimate.rationale) lines.push(`- Rationale: ${estimate.rationale}`)
  }
  if (item.dependsOn?.length) {
    lines.push('', `Depends on: ${item.dependsOn.map((id) => `\`${id}\``).join(', ')}`)
  }
  if (item.pipelineId) lines.push('', `Pipeline: \`${item.pipelineId}\``)
  return lines
}

/**
 * Render an {@link InitiativePlanView} as readable markdown for HUMAN review — the
 * planning counterpart of {@link renderSpecForReview} / {@link renderBlueprintForReview},
 * and the document the `initiative-planner`'s human gate parks on.
 *
 * The planner is a container agent that emits the plan as JSON; its own `result.output` is
 * the raw Pi transcript summary ("Initiative plan drafted."). Parking the gate on THAT gave
 * the reviewer a one-line proposal: nothing to navigate, nothing to quote a comment against,
 * and a "request changes" re-run that handed the planner back a sentence instead of the plan
 * it had just written. Rendering the plan itself is what makes the generic review surface
 * (ToC + per-block comments + approve / request changes / reject) work for it, exactly as it
 * already does for the architect's prose.
 *
 * HEADINGS ARE LOAD-BEARING, not decoration: the reader's outline parser splits the document
 * at each heading into the collapsible sections its table of contents navigates, so every
 * part a reviewer might jump to (each phase, each item, the policy) gets its own heading
 * rather than being folded into a table. Deterministic and dependency-free.
 *
 * NOTHING IS SILENTLY DROPPED. An item is placed by matching its `phaseId` against the
 * phases, and a plan can legitimately reach here with items that match none: a phase's `id`
 * is optional on the draft, and the reference validation only rejects a dangling `phaseId`
 * once at least one phase declares an id. Those items are still ingested and still execute,
 * so they get their own section rather than vanishing — approving a plan whose items you were
 * never shown is exactly the failure this document exists to prevent.
 */
export function renderInitiativePlanForReview(plan: InitiativePlanView): string {
  const lines: string[] = ['# Initiative plan']
  if (plan.goal) lines.push('', '## Goal', '', plan.goal)
  if (plan.constraints?.length) {
    lines.push('', '## Constraints', '', ...plan.constraints.map((c) => `- ${c}`))
  }
  if (plan.nonGoals?.length) {
    lines.push('', '## Non-goals', '', ...plan.nonGoals.map((g) => `- ${g}`))
  }
  if (plan.analysisSummary) lines.push('', '## Codebase analysis', '', plan.analysisSummary)

  const items = plan.items ?? []
  const phases = plan.phases ?? []
  const placed = new Set<(typeof items)[number]>()
  phases.forEach((phase, index) => {
    lines.push('', `## Phase ${index + 1}: ${phase.title}`)
    if (phase.goal) lines.push('', phase.goal)
    if (phase.checkpoint) {
      lines.push(
        '',
        '> Checkpoint — the initiative pauses for human review once this phase settles.',
      )
    }
    if (phase.maxConcurrent !== undefined) {
      lines.push('', `Concurrency for this phase: ${phase.maxConcurrent}.`)
    }
    // An id-less phase matches nothing (an item's `phaseId` is always a non-empty string),
    // so its items surface under "Unplaced items" below rather than being lost.
    const phaseItems = phase.id ? items.filter((item) => item.phaseId === phase.id) : []
    if (phaseItems.length === 0) {
      lines.push('', '_No items in this phase._')
      return
    }
    for (const item of phaseItems) {
      placed.add(item)
      lines.push(...renderPlanItem(item))
    }
  })

  const unplaced = items.filter((item) => !placed.has(item))
  if (unplaced.length > 0) {
    lines.push(
      '',
      '## Unplaced items',
      '',
      `${unplaced.length === 1 ? 'This item names' : 'These items name'} a phase the plan does not declare, so ${unplaced.length === 1 ? 'it is' : 'they are'} listed here rather than under a phase. The initiative still carries ${unplaced.length === 1 ? 'it' : 'them'}.`,
    )
    for (const item of unplaced) {
      lines.push(...renderPlanItem(item), '', `Declared phase: \`${item.phaseId}\`.`)
    }
  }

  const policy = plan.policy
  lines.push('', '## Execution policy', '')
  if (policy) {
    lines.push(
      `- Up to ${policy.maxConcurrent} item${policy.maxConcurrent === 1 ? '' : 's'} run at once.`,
      `- Default pipeline: \`${policy.defaultPipelineId}\`.`,
    )
    for (const rule of policy.rules ?? []) {
      lines.push(`- \`${rule.pipelineId}\` when ${renderRuleAxes(rule)}.`)
    }
  } else {
    // Only reachable for an entity whose policy has not been planned yet; say so rather than
    // omitting the section, which would read as "there is nothing to configure here".
    lines.push('_No execution policy has been agreed yet._')
  }

  if (plan.decisions?.length) {
    lines.push('', '## Decisions', '')
    for (const decision of plan.decisions) {
      lines.push(`- **${decision.title}**${decision.detail ? ` — ${decision.detail}` : ''}`)
    }
  }
  if (plan.caveats?.length) {
    lines.push('', '## Caveats', '', ...plan.caveats.map((c) => `- ${c}`))
  }
  return lines.join('\n')
}

/** Item statuses that count as settled (nothing left for the loop to drive). */
export const INITIATIVE_ITEM_TERMINAL_STATUSES: ReadonlySet<InitiativeItemStatus> = new Set([
  'done',
  'skipped',
])
