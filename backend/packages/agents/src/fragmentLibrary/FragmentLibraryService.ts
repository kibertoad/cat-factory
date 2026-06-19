import type { PromptFragment } from '@cat-factory/contracts'
import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import type {
  CreatePromptFragmentInput,
  FragmentOwnerKind,
  ResolvedFragment,
  UpdatePromptFragmentInput,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { Clock } from '@cat-factory/kernel'
import type {
  FragmentSelector,
  FragmentResolver,
  FragmentResolverInput,
  FragmentRunSelection,
} from '@cat-factory/kernel'
import type { PromptFragmentRecord, PromptFragmentRepository } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { DeterministicFragmentSelector } from './DeterministicFragmentSelector.js'
import {
  type ResolvedCatalogEntry,
  entryToFragment,
  mergeCatalog,
  toSelectable,
} from './fragment-catalog.js'
import { slugFromPath } from './fragment-source.logic.js'

export interface FragmentLibraryServiceDependencies {
  promptFragmentRepository: PromptFragmentRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /** Relevance selector; defaults to the deterministic matcher when omitted. */
  selector?: FragmentSelector
  /** Built-in catalog tier; overridable for tests. Defaults to the shipped FRAGMENTS. */
  builtins?: PromptFragment[]
}

/**
 * The fragment library's management + resolution service (ADR 0006). It owns the
 * per-tier CRUD (account / workspace), resolves the merged catalog a workspace
 * sees (built-in ∪ account ∪ workspace, override-by-id, tombstone-suppressed),
 * and implements {@link FragmentResolver} so the execution engine can fold the
 * relevant fragments into any agent's system prompt — not the reviewer alone.
 */
export class FragmentLibraryService implements FragmentResolver {
  private readonly repo: PromptFragmentRepository
  private readonly workspaces: WorkspaceRepository
  private readonly clock: Clock
  private readonly selector: FragmentSelector
  private readonly builtins: PromptFragment[]

  constructor(deps: FragmentLibraryServiceDependencies) {
    this.repo = deps.promptFragmentRepository
    this.workspaces = deps.workspaceRepository
    this.clock = deps.clock
    this.selector = deps.selector ?? new DeterministicFragmentSelector()
    this.builtins = deps.builtins ?? FRAGMENTS
  }

  /** This tier's hand-authored/sourced fragments (raw, not merged), newest first. */
  async listTier(ownerKind: FragmentOwnerKind, ownerId: string): Promise<PromptFragment[]> {
    const rows = await this.repo.listByOwner(ownerKind, ownerId)
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map((row) => recordToWire(row))
  }

  /** Create a hand-authored fragment at a tier. */
  async create(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    input: CreatePromptFragmentInput,
  ): Promise<PromptFragment> {
    const fragmentId = (input.id ?? slugFromPath(input.title)).trim()
    if (!fragmentId) throw new ValidationError('A fragment id (or a non-empty title) is required')
    const now = this.clock.now()
    const record: PromptFragmentRecord = {
      fragmentId,
      ownerKind,
      ownerId,
      version: input.version ?? '1.0.0',
      title: input.title.trim(),
      category: input.category?.trim() || null,
      summary: input.summary.trim(),
      body: input.body.trim(),
      appliesTo: input.appliesTo ?? null,
      tags: input.tags && input.tags.length ? input.tags : null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.repo.upsert(record)
    return recordToWire(record)
  }

  /**
   * Edit a fragment at a tier. If no row exists yet (e.g. shadowing a built-in or
   * inherited account fragment), the patch must carry enough to stand alone
   * (title, summary, body); otherwise it merges over the existing record.
   */
  async update(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
    patch: UpdatePromptFragmentInput,
  ): Promise<PromptFragment> {
    const existing = await this.repo.get(ownerKind, ownerId, fragmentId)
    const now = this.clock.now()
    const base: PromptFragmentRecord = existing ?? {
      fragmentId,
      ownerKind,
      ownerId,
      version: '1.0.0',
      title: fragmentId,
      category: null,
      summary: '',
      body: '',
      appliesTo: null,
      tags: null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    const next: PromptFragmentRecord = {
      ...base,
      version: patch.version?.trim() ?? base.version,
      title: patch.title?.trim() ?? base.title,
      category: patch.category !== undefined ? patch.category.trim() || null : base.category,
      summary: patch.summary?.trim() ?? base.summary,
      body: patch.body?.trim() ?? base.body,
      appliesTo: patch.appliesTo !== undefined ? patch.appliesTo : base.appliesTo,
      tags: patch.tags !== undefined ? (patch.tags.length ? patch.tags : null) : base.tags,
      updatedAt: now,
      deletedAt: null, // editing un-suppresses
    }
    if (!next.summary || !next.body) {
      throw new ValidationError('A fragment needs a summary and a body')
    }
    await this.repo.upsert(next)
    return recordToWire(next)
  }

  /**
   * Tombstone a fragment at a tier. Suppresses an inherited built-in/account
   * fragment, or removes a hand-authored one. Idempotent — writing a tombstone
   * even when no row exists yet, so a tier can suppress something it inherits.
   */
  async remove(ownerKind: FragmentOwnerKind, ownerId: string, fragmentId: string): Promise<void> {
    const now = this.clock.now()
    const existing = await this.repo.get(ownerKind, ownerId, fragmentId)
    if (existing) {
      await this.repo.softDelete(ownerKind, ownerId, fragmentId, now)
      return
    }
    await this.repo.upsert({
      fragmentId,
      ownerKind,
      ownerId,
      version: '1.0.0',
      title: fragmentId,
      category: null,
      summary: '',
      body: '',
      appliesTo: null,
      tags: null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    })
  }

  /** Resolve the merged catalog a workspace sees (built-in ∪ account ∪ workspace). */
  async resolveCatalog(workspaceId: string): Promise<ResolvedCatalogEntry[]> {
    const accountId = await this.workspaces.accountOf(workspaceId)
    const [accountRows, workspaceRows] = await Promise.all([
      accountId ? this.repo.listByOwner('account', accountId, true) : Promise.resolve([]),
      this.repo.listByOwner('workspace', workspaceId, true),
    ])
    return mergeCatalog(this.builtins, accountRows, workspaceRows)
  }

  /** The merged catalog as wire {@link ResolvedFragment}s for the management UI. */
  async resolvedCatalog(workspaceId: string): Promise<ResolvedFragment[]> {
    const entries = await this.resolveCatalog(workspaceId)
    return entries.map((entry) => ({ ...entryToFragment(entry), tier: entry.tier }))
  }

  /** {@link FragmentResolver}: pick + resolve the fragments to inject for a run. */
  async resolveForRun(input: FragmentResolverInput): Promise<FragmentRunSelection> {
    const catalog = await this.resolveCatalog(input.workspaceId)
    const byId = new Map(catalog.map((e) => [e.id, e]))

    let picked: string[] = []
    try {
      picked = await this.selector.select(catalog.map(toSelectable), {
        agentKind: input.agentKind,
        blockType: input.blockType,
        blockTitle: input.blockTitle,
        blockDescription: input.blockDescription,
        signals: input.signals,
      })
    } catch {
      picked = [] // selection never blocks a run; manual pins still apply
    }

    // Manual pins are authoritative and always included; the selector's picks
    // union with them. Both are validated against the catalog so a stale id is
    // simply dropped rather than breaking the run.
    const selectedIds: string[] = []
    const seen = new Set<string>()
    for (const id of [...input.manualIds, ...picked]) {
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      selectedIds.push(id)
    }
    // Emit in stable catalog order for replay-stable prompts.
    const ordered = catalog.filter((e) => seen.has(e.id))
    return {
      fragments: ordered.map((e) => ({ id: e.id, body: e.body })),
      selectedIds: ordered.map((e) => e.id),
    }
  }
}

function recordToWire(record: PromptFragmentRecord): PromptFragment {
  const fragment: PromptFragment = {
    id: record.fragmentId,
    version: record.version,
    title: record.title,
    category: record.category ?? '',
    summary: record.summary,
    body: record.body,
  }
  if (record.appliesTo) fragment.appliesTo = record.appliesTo
  if (record.tags && record.tags.length) fragment.tags = record.tags
  if (record.sourceId && record.sourcePath !== null && record.sourceSha !== null) {
    fragment.source = { sourceId: record.sourceId, path: record.sourcePath, sha: record.sourceSha }
  }
  return fragment
}
