import type { TaskSourceKind, TaskComment } from '../domain/types.js'
import type { TaskCredentials } from './task-source.js'

// Persistence ports for the task-source integration. The worker implements
// these against D1 (migration 0014); tests can supply in-memory fakes. All rows
// are scoped by workspace and tagged with their `source`, so a single pair of
// tables serves every provider.

/**
 * A workspace's connection to one task source, including its credential bag.
 * Credentials are infrastructure detail (never sent on the wire); they live here
 * so the import path can authenticate against the source for this workspace.
 */
export interface TaskConnectionRecord {
  workspaceId: string
  source: TaskSourceKind
  credentials: TaskCredentials
  /** Human-friendly label for the connection (site URL). */
  label: string
  createdAt: number
  /** Set when the workspace disconnects (tombstone). */
  deletedAt: number | null
}

export interface TaskConnectionRepository {
  /** The workspace's live connection for a source, or null if not connected. */
  getByWorkspace(workspaceId: string, source: TaskSourceKind): Promise<TaskConnectionRecord | null>
  /** Every live connection the workspace holds, across sources. */
  listByWorkspace(workspaceId: string): Promise<TaskConnectionRecord[]>
  /** Create or replace the live connection for a (workspace, source). */
  upsert(record: TaskConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection to a source. */
  softDelete(workspaceId: string, source: TaskSourceKind, at: number): Promise<void>
}

/**
 * The per-workspace on/off toggle for a task source. The absence of a row means
 * the default (enabled): a source is offered as soon as it is available, and the
 * workspace explicitly opts out by persisting `enabled: false` (e.g. a workspace
 * that uses GitHub repos but does not want its issues offered as a task source).
 */
export interface TaskSourceSettingsRecord {
  workspaceId: string
  source: TaskSourceKind
  enabled: boolean
}

export interface TaskSourceSettingsRepository {
  /** Every stored toggle for the workspace (no row ⇒ that source is at its default, enabled). */
  getByWorkspace(workspaceId: string): Promise<TaskSourceSettingsRecord[]>
  /** The stored toggle for one source, or null when at its default. */
  get(workspaceId: string, source: TaskSourceKind): Promise<TaskSourceSettingsRecord | null>
  /** Create or replace the toggle for a (workspace, source). */
  upsert(record: TaskSourceSettingsRecord): Promise<void>
}

/**
 * An issue projected locally for a workspace as a structured record. The cached
 * fields back both the agent-context injection and the list/preview rendering;
 * `linkedBlockId` records the board block this issue is attached to, if any.
 */
export interface TaskRecord {
  workspaceId: string
  source: TaskSourceKind
  externalId: string
  title: string
  url: string
  status: string
  type: string
  assignee: string | null
  priority: string | null
  labels: string[]
  description: string
  comments: TaskComment[]
  excerpt: string
  linkedBlockId: string | null
  syncedAt: number
  deletedAt: number | null
}

/**
 * A (source, externalId) pointer to one imported issue — the key {@link TaskRepository.get}
 * resolves a single row by, and the batch-read key {@link TaskRepository.listByRefs} takes a
 * list of. Named explicitly so callers pass typed refs instead of positional source strings.
 */
export interface TaskRef {
  source: TaskSourceKind
  externalId: string
}

export interface TaskRepository {
  upsert(record: TaskRecord): Promise<void>
  get(workspaceId: string, source: TaskSourceKind, externalId: string): Promise<TaskRecord | null>
  /**
   * Batch-resolve live issues by their (source, externalId) refs in ONE chunked-`IN` read
   * per source — the batch counterpart to {@link get}, so resolving a list of
   * explicitly-named references never becomes a point-read-per-reference (an N+1). Refs that
   * don't resolve are simply absent from the result; order is not guaranteed (callers index
   * the result into a `Map` for per-ref lookup). An empty `refs` list is a no-op.
   */
  listByRefs(workspaceId: string, refs: readonly TaskRef[]): Promise<TaskRecord[]>
  /** Every live issue imported into the workspace, across sources. */
  listByWorkspace(workspaceId: string): Promise<TaskRecord[]>
  /**
   * Resolve a single live issue by its canonical `url` (trailing-slash tolerant),
   * across sources. Used to resolve a URL named explicitly in a block's description
   * against the imported corpus without scanning every issue.
   */
  getByUrl(workspaceId: string, url: string): Promise<TaskRecord | null>
  /** Live issues attached to a board block (resolved during execution). */
  listByBlock(workspaceId: string, blockId: string): Promise<TaskRecord[]>
  /** Attach an issue to a board block (or detach with null). */
  linkBlock(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void>
  /**
   * Detach EVERY issue currently linked to a block, across sources, in one write
   * (`UPDATE … WHERE linked_block_id = ?` — never a loop of per-issue point
   * writes). Used by the recurring intake's replace-link so a reused block's
   * linked context never accumulates across fires.
   */
  unlinkAllFromBlock(workspaceId: string, blockId: string): Promise<void>
}
