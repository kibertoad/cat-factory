import type { TaskSourceKind, TaskComment } from '../domain/types.js'
import type { TaskCredentials } from './task-source.js'

// Persistence ports for the task-source integration. The worker implements
// these against D1 (migration 0014); tests can supply in-memory fakes. All rows
// are scoped by workspace and tagged with their `source`, so a single pair of
// tables serves every provider.

/**
 * A workspace's connection to one task source AS STORED: the credential bag as a SEALED envelope,
 * plus the non-secret label. The document-source sibling
 * ({@link SealedDocumentConnectionRecord}) carries the argument for why the seal is the row's own
 * representation rather than something the repository hides.
 */
export interface SealedTaskConnectionRecord {
  workspaceId: string
  source: TaskSourceKind
  /**
   * AES-GCM envelope over the JSON credential bag, sealed under the deployment's
   * `cat-factory:tasks` cipher — the `task_source_connection` entry of the mothership's
   * `ORG_SECRET_SOURCES` table.
   */
  credentialsCipher: string
  /** Human-friendly label for the connection (site URL). */
  label: string
  createdAt: number
  /** Set when the workspace disconnects (tombstone). */
  deletedAt: number | null
}

export interface TaskConnectionRepository {
  /** The workspace's live connection for a source, or null if not connected. */
  getByWorkspace(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<SealedTaskConnectionRecord | null>
  /** Every live connection the workspace holds, across sources. */
  listByWorkspace(workspaceId: string): Promise<SealedTaskConnectionRecord[]>
  /** Create or replace the live connection for a (workspace, source). */
  upsert(record: SealedTaskConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection to a source. */
  softDelete(workspaceId: string, source: TaskSourceKind, at: number): Promise<void>
}

/**
 * The OPENED view of the same rows: the credential bag the import/webhook paths authenticate
 * with. Credentials are infrastructure detail and never sent on the wire.
 */
export interface TaskConnectionRecord {
  workspaceId: string
  source: TaskSourceKind
  credentials: TaskCredentials
  label: string
  createdAt: number
  deletedAt: number | null
}

/** A stored connection's non-secret half: everything but the credential bag. */
export interface TaskConnectionSummary {
  workspaceId: string
  source: TaskSourceKind
  label: string
  createdAt: number
}

/**
 * The credential-bearing view of {@link TaskConnectionRepository}, and the ONE place a tracker
 * credential is sealed or opened. `DocumentConnectionStore` carries the argument for why the
 * surface is split by how much each caller needs OPENED; implemented by
 * `createTaskConnectionStore` (`@cat-factory/integrations`).
 */
export interface TaskConnectionStore {
  /** The workspace's live connection for a source, opened, or null if not connected. */
  getByWorkspace(workspaceId: string, source: TaskSourceKind): Promise<TaskConnectionRecord | null>
  /**
   * The named sources' live connections, opened, in ONE stored-row read. A source with no stored
   * row is simply absent from the result; empty input reads nothing.
   */
  listBySources(
    workspaceId: string,
    sources: readonly TaskSourceKind[],
  ): Promise<TaskConnectionRecord[]>
  /** Every live connection's non-secret half. Opens no envelope. */
  listSummaries(workspaceId: string): Promise<TaskConnectionSummary[]>
  /** Seal `record`'s bag and store it as the live connection for its (workspace, source). */
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
  /**
   * Attach an issue to a board block (or detach with null), UNCONDITIONALLY.
   *
   * This is the deliberate re-point: the manual "link this issue to this block" action and the
   * recurring intake's per-fire link move, where the caller's whole intent is to overwrite
   * whatever was there. A caller whose intent is instead "file this issue, once" must use
   * {@link claimBlockLink}, or it races.
   */
  linkBlock(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void>
  /**
   * Attach an issue to a block ONLY IF it is not already attached to one, resolving `true` when
   * this caller took it and `false` when someone else already held it.
   *
   * An issue carries a single `linkedBlockId`, so "one task per ticket" is an invariant on this
   * column, and a read-then-{@link linkBlock} cannot enforce it: at Postgres' default READ
   * COMMITTED two concurrent filings of one ticket both read it free and both write, so the
   * second silently strips the first task of the context it was created with, and both tasks
   * survive. That is exactly the shape a redelivering webhook produces. The guard therefore has to
   * live in the WHERE clause (`… AND linked_block_id IS NULL`), which both engines evaluate under
   * the row lock the UPDATE itself takes.
   *
   * Re-claiming with the block that already holds it is a WIN, not a loss: the operation is then
   * idempotent, so a retry after a lost response settles rather than refusing against itself.
   */
  claimBlockLink(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
    blockId: string,
  ): Promise<boolean>
  /**
   * Detach EVERY issue currently linked to a block, across sources, in one write
   * (`UPDATE … WHERE linked_block_id = ?` — never a loop of per-issue point
   * writes). Used by the recurring intake's replace-link so a reused block's
   * linked context never accumulates across fires.
   */
  unlinkAllFromBlock(workspaceId: string, blockId: string): Promise<void>
  /**
   * Detach every issue linked to ANY of the given blocks, in one chunked statement: the batched
   * form of {@link unlinkAllFromBlock}, for the block-delete cascade, which knows the doomed block
   * ids rather than which issues name them. Empty input is a no-op.
   */
  unlinkAllFromBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void>
}
