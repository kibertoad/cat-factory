import * as v from 'valibot'
import { credentialFieldSchema } from './documents.js'

// ---------------------------------------------------------------------------
// Task-source integration wire contracts. A workspace can connect to one or
// more external task/issue trackers (Jira, …), import individual issues
// (projected locally as structured records), and attach an issue to a board
// block as extra agent context.
//
// This is a sibling of the document-source integration, but task-shaped: an
// issue is a first-class structured entity (status / type / assignee / priority
// / labels + a Markdown description + comments), not a single page body. There
// is deliberately no planner/spawn surface — issues are linked for context, not
// expanded into board structure. Storage-only bookkeeping (the owning
// workspace, the credential bag, the soft-delete tombstone) is NOT on the wire;
// it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/** The external task trackers cat-factory can link to. */
export const taskSourceKindSchema = v.picklist(['jira', 'github'])
export type TaskSourceKind = v.InferOutput<typeof taskSourceKindSchema>

// ---- Provider self-description (drives the generic connect UI) ------------
// `credentialFieldSchema` is shared with the document-source contracts: a
// credential form field is identical regardless of what it connects to.

/**
 * Everything the frontend needs to render a source's connect form and import
 * box without hard-coding any provider specifics.
 */
export const taskSourceDescriptorSchema = v.object({
  source: taskSourceKindSchema,
  /** Display name, e.g. `Jira`. */
  label: v.string(),
  /** Lucide icon name for the source. */
  icon: v.string(),
  /** Credentials required to connect, in display order. */
  credentialFields: v.array(credentialFieldSchema),
  /** Label for the "import an issue" input. */
  refLabel: v.string(),
  /** Placeholder for the "import an issue" input. */
  refPlaceholder: v.string(),
  /**
   * Whether this source supports searching its catalogue by title/content (so
   * the UI offers a search box, not just a paste-a-URL field). Optional for
   * backward-compatibility; absent is treated as `false`.
   */
  searchable: v.optional(v.boolean()),
})
export type TaskSourceDescriptor = v.InferOutput<typeof taskSourceDescriptorSchema>

// ---- Connection + task projections ----------------------------------------

/** A workspace's connection to a task source, as exposed to clients (never the credentials). */
export const taskConnectionSchema = v.object({
  source: taskSourceKindSchema,
  /** A human-friendly label for what we're connected to (site URL). */
  label: v.string(),
  /** When the connection was established (epoch ms). */
  connectedAt: v.number(),
})
export type TaskConnection = v.InferOutput<typeof taskConnectionSchema>

/** A single comment on an issue, with its body normalized to Markdown. */
export const taskCommentSchema = v.object({
  /** Comment author's display name; '' when unknown. */
  author: v.string(),
  /** Source-supplied creation timestamp, kept as the source's ISO string. */
  createdAt: v.string(),
  /** Comment body, normalized to lightweight Markdown. */
  body: v.string(),
})
export type TaskComment = v.InferOutput<typeof taskCommentSchema>

/** An issue imported from a source, projected locally as a structured record. */
export const sourceTaskSchema = v.object({
  source: taskSourceKindSchema,
  /** The source's canonical key for the issue (e.g. a Jira issue key `PROJ-123`). */
  externalId: v.string(),
  /** Issue summary / title. */
  title: v.string(),
  /** Canonical URL of the issue on the source. */
  url: v.string(),
  /** Workflow status name, e.g. `In Progress`. */
  status: v.string(),
  /** Issue type name, e.g. `Bug`. */
  type: v.string(),
  /** Assignee display name, or null when unassigned. */
  assignee: v.nullable(v.string()),
  /** Priority name, or null when none. */
  priority: v.nullable(v.string()),
  /** Issue labels. */
  labels: v.array(v.string()),
  /** Issue description, normalized to lightweight Markdown. */
  description: v.string(),
  /** Recent comments, oldest→newest, bodies normalized to Markdown. */
  comments: v.array(taskCommentSchema),
  /** A short plain-text excerpt of the issue (for list/preview rendering). */
  excerpt: v.string(),
  /** The board block this issue is attached to as context, if any. */
  linkedBlockId: v.nullable(v.string()),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type SourceTask = v.InferOutput<typeof sourceTaskSchema>

/**
 * A single hit from searching a tracker. A lean shape (no description/comments)
 * used to populate a picker: selecting one imports it (by `externalId`) and
 * links it to a block. Distinct from {@link SourceTask} — a hit is not yet
 * projected locally, so it carries no `linkedBlockId`/`syncedAt`.
 */
export const taskSearchResultSchema = v.object({
  source: taskSourceKindSchema,
  /** The source's canonical key for the issue (re-usable as an import ref). */
  externalId: v.string(),
  title: v.string(),
  /** Canonical URL of the issue on the source. */
  url: v.string(),
  /** Workflow status name, e.g. `In Progress` (may be empty). */
  status: v.string(),
  /** A short plain-text excerpt for the result row (may be empty). */
  excerpt: v.string(),
})
export type TaskSearchResult = v.InferOutput<typeof taskSearchResultSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Connect a workspace to a task source. The `credentials` bag is validated by
 * the target provider (the `:source` is in the path), keeping the wire shape
 * uniform across providers.
 */
export const connectTaskSourceSchema = v.object({
  credentials: v.record(
    v.string(),
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  ),
})
export type ConnectTaskSourceInput = v.InferOutput<typeof connectTaskSourceSchema>

/** Import (fetch + persist) an issue by its key or a full issue URL. */
export const importTaskSchema = v.object({
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ImportTaskInput = v.InferOutput<typeof importTaskSchema>

/** Search a tracker's issues by free text (title/content). */
export const searchTasksSchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
})
export type SearchTasksInput = v.InferOutput<typeof searchTasksSchema>

/** Attach an imported issue to a task as extra agent context. */
export const linkTaskSchema = v.object({
  source: taskSourceKindSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  blockId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type LinkTaskInput = v.InferOutput<typeof linkTaskSchema>

/**
 * Materialise an imported issue as a new board task (a leaf block) inside a
 * container (service frame or module), and link the issue to it for context. The
 * issue must already be imported (its key is `externalId`). The new task's
 * title/description are seeded from the issue.
 */
export const createTaskFromIssueSchema = v.object({
  source: taskSourceKindSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The frame or module the new task is created in. */
  containerId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type CreateTaskFromIssueInput = v.InferOutput<typeof createTaskFromIssueSchema>
