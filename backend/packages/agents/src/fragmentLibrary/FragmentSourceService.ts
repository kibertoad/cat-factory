import type {
  FragmentOwnerKind,
  FragmentSource,
  FragmentSourceStatus,
  FragmentSyncResult,
  LinkFragmentSourceInput,
} from '@cat-factory/kernel'
import { NotFoundError, ValidationError, assertFound } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { GitHubClient, RepoContentEntry } from '@cat-factory/kernel'
import type {
  FragmentSourceRecord,
  FragmentSourceRepository,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import {
  digestListing,
  isMarkdownFile,
  parseFragmentMarkdown,
  slugFromPath,
} from './fragment-source.logic.js'

/**
 * Resolve the GitHub App installation id that can read a tier's repos. A
 * workspace-owned source reads through the workspace's installation; an
 * account-owned one through the account's. Returns null when no installation is
 * available, so a sync fails with a clear error rather than a silent empty pull.
 */
export type ResolveFragmentInstallationId = (
  ownerKind: FragmentOwnerKind,
  ownerId: string,
) => Promise<number | null>

export interface FragmentSourceServiceDependencies {
  fragmentSourceRepository: FragmentSourceRepository
  promptFragmentRepository: PromptFragmentRepository
  githubClient: GitHubClient
  resolveInstallationId: ResolveFragmentInstallationId
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * Repo-sourced fragments (ADR 0006 §3, §6): link a repo directory of Markdown
 * guidelines to a tier, resync it (read the tree, upsert changed files, tombstone
 * removed ones), and answer the cheap "check for changes" without writing. Reads
 * go through the account's existing GitHub installation — no new credential store.
 * Sync runs inline (bounded directory); the sha-keyed upsert is idempotent so it
 * can later move behind a Workflow safely.
 */
export class FragmentSourceService {
  constructor(private readonly deps: FragmentSourceServiceDependencies) {}

  /** Linked sources for a tier + their last-synced state. */
  async list(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentSource[]> {
    const rows = await this.deps.fragmentSourceRepository.listByOwner(ownerKind, ownerId)
    return rows.map(toWire)
  }

  /** Link a repo directory as a fragment source. Does not sync (call {@link sync}). */
  async link(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    input: LinkFragmentSourceInput,
  ): Promise<FragmentSource> {
    const now = this.deps.clock.now()
    const record: FragmentSourceRecord = {
      id: this.deps.idGenerator.next('frgsrc'),
      ownerKind,
      ownerId,
      repoOwner: input.repoOwner.trim(),
      repoName: input.repoName.trim(),
      gitRef: input.gitRef?.trim() || 'HEAD',
      dirPath: normalizeDir(input.dirPath),
      lastSyncedSha: null,
      lastSyncedAt: null,
      createdAt: now,
      deletedAt: null,
    }
    await this.deps.fragmentSourceRepository.upsert(record)
    return toWire(record)
  }

  /** Unlink a source and tombstone every fragment it produced. */
  async unlink(ownerKind: FragmentOwnerKind, ownerId: string, sourceId: string): Promise<void> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const now = this.deps.clock.now()
    const fragments = await this.deps.promptFragmentRepository.listBySource(sourceId)
    for (const f of fragments) {
      await this.deps.promptFragmentRepository.softDelete(f.ownerKind, f.ownerId, f.fragmentId, now)
    }
    await this.deps.fragmentSourceRepository.softDelete(source.id, now)
  }

  /**
   * Resync a source: list the directory, upsert every Markdown file whose blob
   * sha changed, tombstone fragments no longer produced by any current file, and
   * stamp the new tree digest. Idempotent — re-running with no upstream change
   * touches nothing.
   */
  async sync(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSyncResult> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    // The installation is invariant across the whole sync — resolve it ONCE here,
    // never per file (the per-entry reads below share it).
    const installationId = await this.requireInstallation(source)
    const entries = await this.readMarkdown(source, installationId)
    const existing = await this.deps.promptFragmentRepository.listBySource(sourceId)
    const existingByPath = new Map(existing.map((f) => [f.sourcePath ?? '', f]))
    // Keyed by fragment id too, so `syncEntry` can inherit an existing fragment's
    // version/createdAt when a RENAME reaches it under a new path (path lookup misses,
    // id lookup hits) rather than silently resetting them to defaults.
    const existingById = new Map(existing.map((f) => [f.fragmentId, f]))
    const now = this.deps.clock.now()

    let upserted = 0
    let unchanged = 0
    // The fragment ids the CURRENT tree produces — the survivors. Keyed by id, not
    // path: a rename of a file that pins an explicit frontmatter `id` keeps the same
    // fragment id under a new path, and a path-keyed sweep would tombstone the row
    // the rename just updated. Conversely a file whose explicit `id` changed leaves
    // its OLD id unproduced, which an id-keyed sweep correctly retires.
    const liveIds = new Set<string>()

    for (const entry of entries) {
      const prior = existingByPath.get(entry.path)
      if (prior && prior.sourceSha === entry.sha) {
        unchanged++
        liveIds.add(prior.fragmentId)
        continue
      }
      const syncedId = await this.syncEntry(source, entry, existingById, now, installationId)
      if (syncedId) {
        liveIds.add(syncedId)
        upserted++
      } else if (prior) {
        // Unreadable/unparseable this round: keep the prior fragment alive rather
        // than retiring guidance over a transient read or an in-progress edit.
        liveIds.add(prior.fragmentId)
      }
    }

    // Tombstone fragments the current tree no longer produces (file removed upstream,
    // or its explicit frontmatter `id` changed).
    let tombstoned = 0
    for (const f of existing) {
      if (!liveIds.has(f.fragmentId)) {
        await this.deps.promptFragmentRepository.softDelete(
          f.ownerKind,
          f.ownerId,
          f.fragmentId,
          now,
        )
        tombstoned++
      }
    }

    const lastSyncedSha = digestListing(entries.map((e) => ({ path: e.path, sha: e.sha })))
    await this.deps.fragmentSourceRepository.updateSyncState(source.id, lastSyncedSha, now)
    return { upserted, tombstoned, unchanged, lastSyncedSha }
  }

  /**
   * Cheap "check for changes": compare the remote tree digest to the stored one. It reads
   * only the directory listing (never file bodies), so `changedCount` is a file-level
   * estimate — new/modified files plus files removed upstream. A pure RENAME preserves the
   * blob sha, so it is counted ONCE (the moved file, not also as a deletion) to stay in
   * line with the id-keyed {@link sync} (which upserts the moved fragment without retiring
   * it). It cannot see an in-place explicit-`id` edit (that needs parsing), so for that
   * rare case the count can still trail sync by one; `changed` (the digest comparison) is
   * always exact.
   */
  async status(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSourceStatus> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const entries = await this.readMarkdown(source, await this.requireInstallation(source))
    const existing = await this.deps.promptFragmentRepository.listBySource(sourceId)
    const existingByPath = new Map(existing.map((f) => [f.sourcePath ?? '', f]))
    // A blob sha still present in the current tree is a move/rename, not a deletion.
    const currentShas = new Set(entries.map((e) => e.sha))

    let changedCount = 0
    const seen = new Set<string>()
    for (const entry of entries) {
      seen.add(entry.path)
      const prior = existingByPath.get(entry.path)
      if (!prior || prior.sourceSha !== entry.sha) changedCount++
    }
    for (const f of existing) {
      // A removed path whose blob sha reappears elsewhere in the tree is a rename (already
      // counted as the new path above), so don't also count it as a deletion.
      const movedNotDeleted = f.sourceSha !== null && currentShas.has(f.sourceSha)
      if (f.sourcePath && !seen.has(f.sourcePath) && !movedNotDeleted) changedCount++
    }

    const remoteSha = digestListing(entries.map((e) => ({ path: e.path, sha: e.sha })))
    return {
      changed: remoteSha !== source.lastSyncedSha,
      changedCount,
      lastSyncedSha: source.lastSyncedSha,
      remoteSha,
    }
  }

  // --- internals ----------------------------------------------------------

  private async require(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSourceRecord> {
    const source = assertFound(
      await this.deps.fragmentSourceRepository.get(sourceId),
      'FragmentSource',
      sourceId,
    )
    // The route gates only authorize the addressed owner (account/workspace) prefix, so
    // the record must belong to that owner; 404 hides other tenants' sources entirely.
    if (source.ownerKind !== ownerKind || source.ownerId !== ownerId) {
      throw new NotFoundError('FragmentSource', sourceId)
    }
    if (source.deletedAt !== null) throw new NotFoundError('FragmentSource', sourceId)
    return source
  }

  /** Resolve the GitHub installation that reads this source's tier, or throw cleanly. */
  private async requireInstallation(source: FragmentSourceRecord): Promise<number> {
    const installationId = await this.deps.resolveInstallationId(source.ownerKind, source.ownerId)
    if (installationId === null) {
      throw new ValidationError(
        'No GitHub installation is available for this scope; connect GitHub before syncing a source',
      )
    }
    return installationId
  }

  /** List the source directory and keep only Markdown files (with their shas). */
  private async readMarkdown(
    source: FragmentSourceRecord,
    installationId: number,
  ): Promise<RepoContentEntry[]> {
    const entries = await this.deps.githubClient.listDirectory(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      source.dirPath,
      source.gitRef,
    )
    return entries.filter((e) => e.type === 'file' && isMarkdownFile(e.name))
  }

  /**
   * Read, parse and upsert one file as a fragment owned by the source's tier.
   * Returns the fragment id it produced, or null when the file was unreadable /
   * unparseable (nothing written).
   */
  private async syncEntry(
    source: FragmentSourceRecord,
    entry: RepoContentEntry,
    existingById: Map<string, PromptFragmentRecord>,
    now: number,
    installationId: number,
  ): Promise<string | null> {
    const file = await this.deps.githubClient.getFileContent(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      entry.path,
      source.gitRef,
    )
    if (!file) return null
    const parsed = parseFragmentMarkdown(entry.path, file.content)
    if (!parsed) return null

    // Sourced ids are namespaced so two sources can't collide; an explicit
    // frontmatter `id` instead *shadows* a built-in/inherited fragment (ADR 0006).
    const fragmentId = parsed.id?.trim() || `src:${source.id}:${slugFromPath(entry.path)}`
    // Match the existing row by the id THIS file produces, not by path — so a rename
    // (new path, same explicit id) still inherits the fragment's version + createdAt,
    // while a genuinely new id (a fresh file, or a file whose explicit id changed) starts
    // fresh and lets the sweep retire the old id.
    const prior = existingById.get(fragmentId)
    const record: PromptFragmentRecord = {
      fragmentId,
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      version: prior?.version ?? '1.0.0',
      title: parsed.title,
      category: parsed.category ?? null,
      summary: parsed.summary,
      body: parsed.body,
      appliesTo: parsed.appliesTo ?? null,
      tags: parsed.tags && parsed.tags.length ? parsed.tags : null,
      sourceId: source.id,
      sourcePath: entry.path,
      sourceSha: file.sha,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.promptFragmentRepository.upsert(record)
    return fragmentId
  }
}

function normalizeDir(dirPath: string | undefined): string {
  return (dirPath ?? '').replace(/^\/+|\/+$/g, '')
}

function toWire(record: FragmentSourceRecord): FragmentSource {
  return {
    id: record.id,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    gitRef: record.gitRef,
    dirPath: record.dirPath,
    lastSyncedSha: record.lastSyncedSha,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
  }
}
