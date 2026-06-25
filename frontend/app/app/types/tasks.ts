// ---------------------------------------------------------------------------
// Task-source integration. Individual issues imported from external task
// trackers (Jira, …) can be attached to a board task as agent context. These
// mirror the `@cat-factory/contracts` task schemas; the abstraction is
// source-agnostic, keyed by `source`. Unlike document sources there is no
// plan/spawn — an issue is linked for context, never expanded into structure.
// ---------------------------------------------------------------------------

import type { CredentialField } from './documents'

/** The external task trackers cat-factory can link to. */
export type TaskSourceKind = 'jira' | 'github'

export type { CredentialField }

/** A source's self-description: drives the generic connect + import UI. */
export interface TaskSourceDescriptor {
  source: TaskSourceKind
  label: string
  /** Lucide icon name for the source. */
  icon: string
  credentialFields: CredentialField[]
  refLabel: string
  refPlaceholder: string
  /** Whether the source supports searching its catalogue by title/content. */
  searchable?: boolean
}

/**
 * A source's descriptor plus the workspace's live state: whether it's usable now
 * (`available` — a credentialed source is connected; GitHub Issues' App is
 * installed) and whether the workspace offers it (`enabled`, the per-workspace
 * toggle, default true). `available && enabled` is what makes a source offered.
 */
export interface TaskSourceState extends TaskSourceDescriptor {
  available: boolean
  enabled: boolean
}

/**
 * The verdict of a live "check setup" probe against a source (mirrors
 * `@cat-factory/contracts`). Unlike `available` (a passive row-exists flag) this
 * is the result of actually authenticating + reading, so it distinguishes a
 * configured-but-broken source from a working one.
 */
export type TaskSourceDiagnosticStatus =
  | 'ready'
  | 'not_installed'
  | 'not_connected'
  | 'auth_failed'
  | 'forbidden'
  | 'unreachable'
  | 'error'

export interface TaskSourceDiagnostic {
  source: TaskSourceKind
  ok: boolean
  status: TaskSourceDiagnosticStatus
  /** A one-line, actionable explanation shown verbatim in the panel. */
  message: string
  /** Optional extra context (account login, repo count, signed-in user). */
  detail?: string | null
}

/** A workspace's connection to a task source (never carries credentials). */
export interface TaskConnection {
  source: TaskSourceKind
  /** Human-friendly label for what we're connected to (site URL). */
  label: string
  /** When the connection was established (epoch ms). */
  connectedAt: number
}

/** A single comment on an issue, with its body as lightweight Markdown. */
export interface TaskComment {
  author: string
  createdAt: string
  body: string
}

/** An issue imported from a source into the workspace, as a structured record. */
export interface SourceTask {
  source: TaskSourceKind
  /** The source's canonical key for the issue (e.g. `PROJ-123`). */
  externalId: string
  title: string
  url: string
  /** Workflow status name, e.g. `In Progress`. */
  status: string
  /** Issue type name, e.g. `Bug`. */
  type: string
  /** Assignee display name, or null when unassigned. */
  assignee: string | null
  /** Priority name, or null when none. */
  priority: string | null
  labels: string[]
  /** Issue description as lightweight Markdown. */
  description: string
  comments: TaskComment[]
  /** Short plain-text preview of the issue. */
  excerpt: string
  /** The board block this issue is attached to as context, if any. */
  linkedBlockId: string | null
  syncedAt: number
}

/** A lean hit from searching a tracker's issues (not yet imported). */
export interface TaskSearchResult {
  source: TaskSourceKind
  /** The source's canonical key for the issue (re-usable as an import ref). */
  externalId: string
  title: string
  url: string
  /** Workflow status name, e.g. `In Progress` (may be empty). */
  status: string
  /** Short plain-text preview (may be empty). */
  excerpt: string
}
