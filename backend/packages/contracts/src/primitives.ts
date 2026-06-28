import * as v from 'valibot'

// Shared scalar schemas. Picklists mirror the frontend's `app/types/domain.ts`
// unions exactly, so a payload that validates here drops straight into the Pinia
// stores without translation.

export const blockTypeSchema = v.picklist([
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
])
export type BlockType = v.InferOutput<typeof blockTypeSchema>

export const blockStatusSchema = v.picklist([
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'pr_ready',
  'done',
])
export type BlockStatus = v.InferOutput<typeof blockStatusSchema>

/**
 * A block's place in the board hierarchy. `frame`/`module`/`task` form the
 * structural containment tree (`parentId`); `epic` is a NON-structural grouping
 * node — it groups tasks (which may live under different modules/services) via
 * their `epicId` membership link, not via `parentId`, so deleting an epic never
 * deletes its member tasks.
 */
export const blockLevelSchema = v.picklist(['frame', 'module', 'task', 'epic'])
export type BlockLevel = v.InferOutput<typeof blockLevelSchema>

/**
 * The kind of work a task represents, chosen by the human at creation. Drives the
 * task card's icon/badge, per-type creation fields, and (optionally) the per-service
 * running-task limit's bucketing. `recurring` is special: such tasks are NOT created
 * through `addTask` — they are the reused on-board block of a recurring-pipeline
 * schedule, stamped with this type so the board renders them consistently.
 */
export const taskTypeSchema = v.picklist(['feature', 'bug', 'document', 'spike', 'recurring'])
export type TaskType = v.InferOutput<typeof taskTypeSchema>

/** The task types a human can pick in the create-task form (recurring is created via a schedule). */
export const createTaskTypeSchema = v.picklist(['feature', 'bug', 'document', 'spike'])
export type CreateTaskType = v.InferOutput<typeof createTaskTypeSchema>

/**
 * The kinds of document a `document` task can produce. Drives the document-authoring
 * pipeline's prompts (each kind implies a structure: a PRD vs an RFC vs a runbook) and
 * the default in-repo location the writer commits to. An open-ended `reference`/`other`
 * keeps the list from constraining genuine one-offs.
 */
export const DOC_KINDS = [
  'prd',
  'rfc',
  'adr',
  'design',
  'technical',
  'api',
  'runbook',
  'research',
  'reference',
  'other',
] as const
export type DocKind = (typeof DOC_KINDS)[number]

/**
 * Whether a `document` task's `targetPath` is a SAFE relative Markdown path. The value is used
 * verbatim as the in-repo file the doc-writer commits, so it must not escape the repo or
 * clobber non-document files: no `..` traversal, no absolute path (`/…` or a Windows drive),
 * no backslash / NUL, and it must end in `.md`. Rejecting e.g. `../../package.json` at the
 * write boundary stops a malformed (or hostile) path from overwriting arbitrary repo files.
 */
export function isSafeDocPath(path: string): boolean {
  const p = path.trim()
  if (!p || p.length > 300) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  if (p.includes('\\') || p.includes('\0')) return false
  if (p.split('/').some((segment) => segment === '..')) return false
  return p.toLowerCase().endsWith('.md')
}

/**
 * Small, additive, per-type fields collected on the create-task form. All optional;
 * which ones are shown depends on the chosen {@link TaskType}. Stored verbatim on the
 * block as a sparse object so adding a field never needs a schema migration.
 */
export const taskTypeFieldsSchema = v.object({
  /** Bug: how severe the defect is. */
  severity: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
  /** Bug: reproduction steps / observed-vs-expected. */
  stepsToReproduce: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  /** Spike: the investigation time-box, in hours. */
  timeboxHours: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1000))),
  /** Document: what kind of document this task produces. */
  docKind: v.optional(v.picklist(DOC_KINDS)),
  /** Document: the intended audience (e.g. "platform engineers", "product stakeholders"). */
  audience: v.optional(v.pipe(v.string(), v.maxLength(300))),
  /**
   * Document: an explicit in-repo path the document is written to, overriding the
   * pipeline's default `docs/<kind>/<slug>.md` location (e.g. `docs/rfcs/0001-foo.md`).
   * Constrained to a safe relative Markdown path (see {@link isSafeDocPath}) so it can't
   * escape the repo or overwrite non-document files.
   */
  targetPath: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(300),
      v.check(
        isSafeDocPath,
        'targetPath must be a relative path inside the repo, ending in .md, with no "..", absolute, or backslash segments.',
      ),
    ),
  ),
  /** Document: freeform hints on the sections / structure the author should produce. */
  outlineHints: v.optional(v.pipe(v.string(), v.maxLength(4000))),
})
export type TaskTypeFields = v.InferOutput<typeof taskTypeFieldsSchema>

export const agentStateSchema = v.picklist(['pending', 'working', 'waiting_decision', 'done'])
export type AgentState = v.InferOutput<typeof agentStateSchema>

/** Agent kinds are an open set — custom agents get free-form ids. */
export const agentKindSchema = v.pipe(v.string(), v.minLength(1))
export type AgentKind = v.InferOutput<typeof agentKindSchema>

export const positionSchema = v.object({
  x: v.number(),
  y: v.number(),
})
export type Position = v.InferOutput<typeof positionSchema>

/**
 * An explicit pixel size for a resizable block (a service frame today). Optional
 * on a block: when absent the board auto-sizes the frame from its contents; when
 * present it is the user's dragged size, clamped client-side to never shrink below
 * the content's natural extent. Strictly positive.
 */
export const sizeSchema = v.object({
  w: v.pipe(v.number(), v.minValue(1)),
  h: v.pipe(v.number(), v.minValue(1)),
})
export type Size = v.InferOutput<typeof sizeSchema>
