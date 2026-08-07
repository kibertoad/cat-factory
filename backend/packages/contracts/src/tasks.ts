import * as v from 'valibot'
import { credentialFieldSchema } from './documents.js'
import { namespacedIdSchema } from './primitives.js'
import { vcsProviderSchema } from './routes/auth.js'

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

/** The task sources this build ships. A deployment registers its own beside them (see below). */
export const BUILTIN_TASK_SOURCE_KINDS = ['jira', 'github', 'linear', 'gitlab'] as const

/**
 * One of the sources this build ships, as a type. Its use is a `Record<BuiltinTaskSourceKind, …>`
 * where a caller must state something for EVERY built-in and a deployment-registered source is
 * handled separately: a fifth built-in then fails to compile until it has an answer, where an
 * `if`-chain over the same ids would silently fall through to whatever the last branch returns.
 */
export type BuiltinTaskSourceKind = (typeof BUILTIN_TASK_SOURCE_KINDS)[number]

/**
 * A BUILT-IN task source OR a CONSUMER-namespaced one ({@link namespacedIdSchema},
 * `<ns>:<name>`, e.g. `acme:servicenow`) a deployment registers in code on its app-owned
 * `TaskSourceRegistry` — the same `picklist ∪ namespaced` shape `taskTypeSchema` uses, for the
 * same reasons.
 *
 * Two consequences are load-bearing:
 *
 *  - **The built-ins keep their BARE ids**, so every persisted `source` column, every stored
 *    connection and every imported issue row is unchanged by the widening. There is no migration
 *    here because there is nothing to migrate.
 *  - **A bare non-built-in id still FAILS validation.** `servicenow` is a typo; `acme:servicenow`
 *    is a deployment's registration. Keeping the namespace mandatory is what tells those apart,
 *    and it is why widening does not turn every misspelled `:source` path segment into a
 *    plausible-looking miss.
 *
 * The schema is the GRAMMAR, never the authority on what EXISTS: a namespaced id passes here and
 * is then resolved against the registry at the boundary, so an id no deployment registered is
 * refused by the thing that actually knows.
 */
export const taskSourceKindSchema = v.union([
  v.picklist(BUILTIN_TASK_SOURCE_KINDS),
  namespacedIdSchema,
])
export type TaskSourceKind = v.InferOutput<typeof taskSourceKindSchema>

/**
 * Type guard for the source GRAMMAR, so a caller with a raw path segment (the webhook receiver's
 * `:source`) can pre-filter without importing valibot.
 *
 * It deliberately does NOT answer whether the source EXISTS. A grammatically valid id is resolved
 * against the registry immediately afterwards, and that is what refuses an unregistered one — so
 * the two failures stay distinct: a malformed segment is a bad request, an unregistered one is a
 * source this deployment does not serve.
 */
export function isTaskSourceKind(value: unknown): value is TaskSourceKind {
  return typeof value === 'string' && v.is(taskSourceKindSchema, value)
}

// ---- Inbound tracker webhooks (push-driven intake + ticket replies) --------
// The per-connection delivery endpoint an operator pastes into the tracker's webhook form, plus
// the secret that authenticates it. The secret rides the connection's sealed credential bag (no
// new table), so this surface is purely mint/read/clear. See
// `backend/docs/adr/0032-tracker-webhook-intake.md`.

/** The webhook state of one task-source connection, safe to read back at any time. */
export const taskSourceWebhookSchema = v.object({
  source: taskSourceKindSchema,
  /**
   * Whether this source can receive webhooks at all on this deployment (its provider ships a
   * webhook adapter). `false` ⇒ the delivery path 404s and minting is refused.
   */
  supported: v.boolean(),
  /** Whether a secret is currently stored — i.e. whether deliveries will be accepted. */
  configured: v.boolean(),
  /**
   * The path to paste into the tracker, relative to the deployment's public base URL. Returned
   * even when unconfigured so an operator can see where deliveries will go before minting.
   */
  deliveryPath: v.string(),
  /**
   * Comma-separated author handles / emails / vendor ids allowed to drive a parked review from a
   * ticket comment. Empty ⇒ any NON-BOT author, which is the right default for a private tracker
   * and the wrong one for a public repo.
   */
  replyAllow: v.string(),
})
export type TaskSourceWebhook = v.InferOutput<typeof taskSourceWebhookSchema>

/**
 * The freshly-minted secret, returned EXACTLY ONCE. It is sealed into the connection's credential
 * bag immediately and never read back — the same one-shot contract as an API key, for the same
 * reason: a secret a surface will hand out again is a secret an operator never has to rotate.
 */
export const taskSourceWebhookSecretSchema = v.object({
  ...taskSourceWebhookSchema.entries,
  secret: v.string(),
})
export type TaskSourceWebhookSecret = v.InferOutput<typeof taskSourceWebhookSecretSchema>

/**
 * Mint (or rotate) the connection's webhook secret, optionally seeding the reply allow-list in the
 * same call so first-time setup is one round trip. Editing the allow-list LATER goes through
 * {@link updateTaskSourceWebhookSchema} instead — rotation is destructive (the tracker's configured
 * secret stops verifying immediately), so it must never be a side effect of an unrelated edit.
 */
export const configureTaskSourceWebhookSchema = v.object({
  replyAllow: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
})
export type ConfigureTaskSourceWebhookInput = v.InferOutput<typeof configureTaskSourceWebhookSchema>

/**
 * Edit the reply allow-list, leaving the secret alone.
 *
 * Its own route because tightening the allow-list is exactly what an operator does when a tracker
 * turns out to be more public than they thought — and folding it into the mint would answer that
 * with a rotated secret and a dead webhook until they re-paste it. `replyAllow` is required here:
 * a PATCH with nothing to set is a caller mistake, not a no-op.
 */
export const updateTaskSourceWebhookSchema = v.object({
  replyAllow: v.pipe(v.string(), v.maxLength(2_000)),
})
export type UpdateTaskSourceWebhookInput = v.InferOutput<typeof updateTaskSourceWebhookSchema>

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
  /**
   * Whether this source connects via an OAuth redirect (the UI shows a "Connect
   * with X" button that GETs the install URL) in addition to / instead of the
   * `credentialFields` form. Optional; absent is treated as `false`. The OAuth
   * button is only actionable when the deployment configured the provider's OAuth
   * app — `available`/the install-url endpoint reflect that.
   */
  oauth: v.optional(v.boolean()),
})
export type TaskSourceDescriptor = v.InferOutput<typeof taskSourceDescriptorSchema>

/** A Linear team, offered in the ticket-filing team picker. */
export const linearTeamSchema = v.object({
  id: v.string(),
  name: v.string(),
  key: v.string(),
})
export type LinearTeam = v.InferOutput<typeof linearTeamSchema>

/**
 * A source's descriptor plus the workspace's live state for it: whether it is
 * usable right now (`available`) and whether the workspace offers it (`enabled`,
 * the per-workspace toggle, default true). A credentialed source (Jira) is
 * `available` once connected; a VCS-backed one (GitHub Issues, GitLab Issues) is
 * `available` once the workspace's VCS connection is that source's provider (it
 * rides that connection, so there is nothing to connect on the source itself).
 * `available && enabled` is what makes a source offered for import.
 */
export const taskSourceStateSchema = v.object({
  ...taskSourceDescriptorSchema.entries,
  available: v.boolean(),
  enabled: v.boolean(),
  /**
   * The VCS provider whose workspace connection this source authenticates through, or `null`
   * for a source that carries its own credentials.
   *
   * On the wire because the REMEDY for an unavailable source is not derivable from
   * `available: false` plus an empty `credentialFields`: "connect Jira" opens this source's own
   * credential form, while "the GitLab connection is missing" points at an entirely different
   * settings surface, and pointing at the wrong one is a worse failure than saying nothing. It
   * is DERIVED from the registered provider for the same reason `supportsIntake` is: a
   * descriptor field declaring it would drift from the availability rule it is supposed to
   * explain.
   */
  ridesVcsProvider: v.nullable(vcsProviderSchema),
  /**
   * Whether this source can back a recurring `bug-intake` schedule, i.e. whether its provider
   * implements the predicate search intake runs. DERIVED from the provider rather than declared
   * on the descriptor beside it, because the answer is a fact about the registered
   * implementation and a declared one drifts from it silently.
   *
   * It is on the STATE rather than the descriptor for the same reason `available` is: a source
   * the schedule form offers but cannot search is not a source with a missing field, it is a
   * schedule that can never fire, and the form has to know which before it renders a picker.
   */
  supportsIntake: v.boolean(),
})
export type TaskSourceState = v.InferOutput<typeof taskSourceStateSchema>

// ---- Live setup diagnostics ------------------------------------------------

/**
 * The verdict of a live "check setup" probe against a source. Distinct from the
 * passive `available` flag (which only says a connection/installation row
 * exists): this is the result of actually authenticating and reading, so it can
 * tell a configured-but-broken source from a working one.
 *   - `ready`         — authenticated and the issues API answered.
 *   - `not_installed` — GitHub Issues' App isn't installed on the workspace.
 *   - `not_connected` — a credentialed source (Jira) has no connection.
 *   - `auth_failed`   — credentials/App key were rejected (HTTP 401).
 *   - `forbidden`     — authenticated but lacking the needed scope, e.g. the
 *                       GitHub App has no Issues permission (HTTP 403).
 *   - `unreachable`   — the source host could not be reached (network / DNS).
 *   - `error`         — anything else (unexpected status or body).
 */
export const taskSourceDiagnosticStatusSchema = v.picklist([
  'ready',
  'not_installed',
  'not_connected',
  'auth_failed',
  'forbidden',
  'unreachable',
  'error',
])
export type TaskSourceDiagnosticStatus = v.InferOutput<typeof taskSourceDiagnosticStatusSchema>

/** A source's live setup-check result: a status + a human-readable, actionable message. */
export const taskSourceDiagnosticSchema = v.object({
  source: taskSourceKindSchema,
  /** Convenience: `status === 'ready'`. */
  ok: v.boolean(),
  status: taskSourceDiagnosticStatusSchema,
  /** A one-line explanation the panel shows verbatim (what's wrong + how to fix). */
  message: v.string(),
  /** Optional extra context, e.g. the resolved account login or repo count. */
  detail: v.optional(v.nullable(v.string())),
})
export type TaskSourceDiagnostic = v.InferOutput<typeof taskSourceDiagnosticSchema>

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

/**
 * A dependency relationship an issue declares to another issue, normalized across
 * sources (Jira issue links / GitHub body references). Direction matters: `blockedBy`
 * / `dependsOn` mean THIS issue waits on the linked one (→ a `dependsOn` board edge);
 * `blocks` is the inverse (the linked issue waits on this one); `relates` is a
 * non-blocking association the importer ignores for sequencing.
 */
export const taskDependencyLinkSchema = v.object({
  type: v.picklist(['blockedBy', 'dependsOn', 'blocks', 'relates']),
  /** The canonical external id of the linked issue (same id space as `externalId`). */
  externalId: v.string(),
})
export type TaskDependencyLink = v.InferOutput<typeof taskDependencyLinkSchema>

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

/** Enable or disable a task source for the workspace (the per-workspace toggle). */
export const setTaskSourceEnabledSchema = v.object({
  enabled: v.boolean(),
})
export type SetTaskSourceEnabledInput = v.InferOutput<typeof setTaskSourceEnabledSchema>

/** Import (fetch + persist) an issue by its key or a full issue URL. */
export const importTaskSchema = v.object({
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ImportTaskInput = v.InferOutput<typeof importTaskSchema>

/**
 * Machine-readable causes of a REFUSED task-source read (an issue search, a board listing),
 * carried on the 400's `error.details.reason` so the SPA can word each case precisely — and,
 * for the two that have a fix attached, point at it — instead of showing the backend's
 * untranslated prose (CLAUDE.md "Backend strings").
 *
 * Single source of truth lives HERE, like {@link CONFLICT_REASONS}, because the emit sites and
 * the consumer sit in different packages: `@cat-factory/server` and `@cat-factory/integrations`
 * throw these, the SPA maps them to localized copy. A bare string literal on both sides is how
 * a rename silently degrades the SPA to the generic message with nothing failing to typecheck.
 */
export const TASK_SOURCE_READ_REASONS = [
  // The search's originating service frame has no linked repository, so there is nothing to
  // scope a repo-backed search to. The one reason with a user-facing fix: link a repo.
  'repo_not_linked',
  // A repo-backed provider was asked to search with no scope at all. Defence in depth behind
  // the required `blockId` and `repo_not_linked` — unreachable from the SPA, which is why it
  // maps to no bespoke copy.
  'repo_scope_required',
  // A `bug-intake` schedule or bug hunt reached the GitHub query builder with no repository
  // configured. Refused rather than searching everything the credential can reach.
  'missing_board',
  // A board scope that is not a plain `owner/repo` slug — it could smuggle a second search
  // qualifier past the `repo:` prefix and widen the very scope it is meant to pin.
  'invalid_board',
  // The tracker cannot enumerate boards for a bug hunt, so the SPA offers a free-text field
  // instead. Distinct from a tracker OUTAGE, which must be shown as the error it is.
  'boards_unsupported',
] as const

export type TaskSourceReadReason = (typeof TASK_SOURCE_READ_REASONS)[number]

/** Search a tracker's issues by free text (title/content). */
export const searchTasksSchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /**
   * The board block the search runs from (a service frame or one of its tasks/modules).
   * REQUIRED: for a repo-backed source (GitHub Issues) it is what scopes the search to that
   * service's linked repository, so hits never leak in from other repos and a bare issue
   * number resolves against the service's repo. There is deliberately no unscoped mode —
   * an unscoped GitHub issue search reaches every repository the deployment's credential can
   * see, which for a PAT is all of public GitHub. Repo-less sources (Jira, Linear) still
   * receive it and simply have nothing to narrow.
   */
  blockId: v.pipe(v.string(), v.trim(), v.minLength(1)),
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

/**
 * Spawn an epic and its children onto the board: create an `epic`-level grouping node
 * from the referenced issue, materialise each child issue as a board task inside the
 * chosen container (all joined to the epic via `epicId`), and seed `dependsOn` edges from
 * the issues' "blocked by"/"depends on" links. `ref` is the epic issue (URL or key);
 * `containerId` is the service frame / module the child tasks land in.
 */
export const spawnEpicSchema = v.object({
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  containerId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** Where to place the epic node on the board; defaults applied server-side when absent. */
  position: v.optional(v.object({ x: v.number(), y: v.number() })),
})
export type SpawnEpicInput = v.InferOutput<typeof spawnEpicSchema>
