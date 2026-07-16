import type { GitHubClient } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Shared repo-source sync mechanics, extracted from the fragment library (ADR
// 0006 §6) so the Claude Skills library (docs/initiatives/repo-skills.md) reuses
// them rather than copying the shape. It owns the parts every repo-sourced tier
// gets identically: pin the source dir's head commit BEFORE reading (so a commit
// landing mid-sync is recorded as the pinned sha and the next status flags it,
// never silently treated as current), run the caller's per-unit reconcile, sweep
// tombstones by produced id (a rename retires the old id), stamp the sync state,
// and invalidate the tier's cache ONLY when a row actually changed. The differing
// part — what a "unit" is (a Markdown file for fragments, a `<skill>/SKILL.md`
// directory for skills) and how it maps to a persisted row — is the injected
// `reconcile`.
// ---------------------------------------------------------------------------

/** The linked-source coordinates the sync reads from. */
export interface RepoSourceCoords {
  repoOwner: string
  repoName: string
  gitRef: string
  dirPath: string
  /** Head commit sha the dir was pinned to at the last sync; null before the first. */
  lastSyncedCommit: string | null
}

/** Counts returned to the caller (and its wire result). */
export interface RepoSourceSyncOutcome {
  upserted: number
  tombstoned: number
  unchanged: number
  /** Head commit sha the source dir was synced to (the freshly pinned commit). */
  lastSyncedCommit: string | null
}

/** The read context handed to a caller's {@link SyncRepoSourceParams.reconcile}. */
export interface ReconcileContext {
  /** The ref to read repo content at — the pinned head commit sha, else the source's gitRef. */
  readRef: string
  /**
   * Whether the pinned commit advanced since the last sync. Lets a reconcile re-list
   * a unit's sub-parts even when the unit's own blob sha is unchanged — a
   * resource-only edit advances the dir head without touching `SKILL.md`'s sha.
   */
  commitMoved: boolean
  /** Epoch ms to stamp on every row written this pass. */
  now: number
}

/** What a reconcile reports back after upserting the changed units. */
export interface ReconcileResult {
  /** The produced ids the CURRENT tree yields — the survivors the tombstone sweep keeps. */
  liveIds: Set<string>
  upserted: number
  unchanged: number
  /**
   * A changed unit was detected but could NOT be applied this round (e.g. its
   * manifest read back as a 404/non-file, or parsed empty) and the prior row was kept
   * alive instead of retiring it. When set, the engine does NOT advance the pinned
   * commit to the new head — otherwise the source would look "caught up" while a stale
   * row is served indefinitely, since a later status probe (head unchanged) would
   * report no change and the next resync would short-circuit. Leaving the pin behind
   * makes the next sync re-read that unit (self-healing once the transient clears).
   */
  incomplete?: boolean
}

export interface SyncRepoSourceParams<Existing> {
  source: RepoSourceCoords
  /** Resolved ONCE by the caller (never per unit) and passed through to reads. */
  installationId: number
  githubClient: Pick<GitHubClient, 'latestCommitSha' | 'listDirectory' | 'getFileContent'>
  now: number
  /** The rows the source currently produces, for diffing + the tombstone sweep. */
  listExisting: () => Promise<Existing[]>
  existingId: (e: Existing) => string
  /** Upsert the changed units at `ctx.readRef`; report the survivors + counts. */
  reconcile: (ctx: ReconcileContext, existing: Existing[]) => Promise<ReconcileResult>
  tombstone: (e: Existing, now: number) => Promise<void>
  updateSyncState: (commit: string | null, now: number) => Promise<void>
  /** Called AFTER the sync state commits, only when a row actually changed. */
  invalidate?: () => Promise<void>
}

/**
 * Run one resync of a repo source. Idempotent: re-running with no upstream change
 * touches nothing and skips the cache invalidation.
 */
export async function syncRepoSource<Existing>(
  params: SyncRepoSourceParams<Existing>,
): Promise<RepoSourceSyncOutcome> {
  const { source, installationId, githubClient, now } = params
  const headCommit = await githubClient.latestCommitSha(
    installationId,
    { owner: source.repoOwner, repo: source.repoName },
    source.dirPath,
    source.gitRef,
  )
  const readRef = headCommit ?? source.gitRef
  const commitMoved = headCommit !== source.lastSyncedCommit
  const existing = await params.listExisting()
  const { liveIds, upserted, unchanged, incomplete } = await params.reconcile(
    { readRef, commitMoved, now },
    existing,
  )

  // Tombstone the rows the current tree no longer produces (removed upstream, or an
  // id-defining rename), keyed by produced id so a rename doesn't retire the row it
  // just updated under a new path.
  let tombstoned = 0
  for (const e of existing) {
    if (!liveIds.has(params.existingId(e))) {
      await params.tombstone(e, now)
      tombstoned++
    }
  }

  // Only advance the pin when the tree was fully reconciled: an incomplete pass (a
  // changed unit kept stale over an unreadable/empty manifest) leaves the pin behind so
  // the next sync re-reads it rather than silently serving stale content forever.
  const syncedCommit = incomplete ? source.lastSyncedCommit : headCommit
  await params.updateSyncState(syncedCommit, now)
  if (upserted > 0 || tombstoned > 0) await params.invalidate?.()
  return { upserted, tombstoned, unchanged, lastSyncedCommit: syncedCommit }
}

export interface RepoSourceStatus {
  changed: boolean
  lastSyncedCommit: string | null
  remoteCommit: string | null
}

/**
 * The lightweight "check for changes": one cheap head-commit read compared against
 * the last-synced commit — no directory listing, no file bodies (already persisted
 * on our side). Exact at commit granularity: any commit touching the dir advances
 * the head sha.
 */
export async function probeRepoSourceStatus(params: {
  source: RepoSourceCoords
  installationId: number
  githubClient: Pick<GitHubClient, 'latestCommitSha'>
}): Promise<RepoSourceStatus> {
  const { source, installationId, githubClient } = params
  const remoteCommit = await githubClient.latestCommitSha(
    installationId,
    { owner: source.repoOwner, repo: source.repoName },
    source.dirPath,
    source.gitRef,
  )
  return {
    changed: remoteCommit !== source.lastSyncedCommit,
    lastSyncedCommit: source.lastSyncedCommit,
    remoteCommit,
  }
}

/** Strip leading/trailing slashes so a linked dir path is stored canonically. */
export function normalizeDirPath(dirPath: string | undefined): string {
  return (dirPath ?? '').replace(/^\/+|\/+$/g, '')
}
