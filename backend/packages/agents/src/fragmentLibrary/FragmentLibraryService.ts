import type { PromptFragment } from '@cat-factory/contracts'
import type {
  CreateDocumentFragmentInput,
  CreatePromptFragmentInput,
  DocumentContent,
  DocumentContentResolver,
  DocumentSourceKind,
  FragmentOwnerKind,
  ResolvedFragment,
  UpdatePromptFragmentInput,
} from '@cat-factory/kernel'
import { ValidationError, buildExcerpt } from '@cat-factory/kernel'
import type {
  Clock,
  GroupCacheHandle,
  Logger,
  OperationalMetrics,
  PromptFragmentSource,
} from '@cat-factory/kernel'
import { noopLogger, noopOperationalMetrics } from '@cat-factory/kernel'
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
import type { FragmentBriefService } from './FragmentBriefService.js'
import { slugFromPath } from './fragment-source.logic.js'

/**
 * How verbose a run's folded standards are, mirrored from `@cat-factory/agents`'
 * `StandardsVerbosity` (declared structurally here so the library layer does not depend on
 * the prompt-composition layer). Only a `brief` dispatch resolves condensed variants — an
 * implementer kind is the whole reason they exist, and generating one for a reviewer's
 * dispatch would pay for text that reviewer will never fold.
 */
export type FragmentStandardsVerbosity = 'full' | 'brief'

/** Options for {@link FragmentLibraryService.resolveBodiesForRun}. */
export interface ResolveBodiesOptions {
  /** An already-resolved merged catalog, to avoid resolving the same tenant catalog twice. */
  catalog?: ResolvedCatalogEntry[]
  /** The dispatching kind's standards verbosity; defaults to `full`. */
  verbosity?: FragmentStandardsVerbosity
  /**
   * The run this resolution is for. Only a `brief` dispatch can generate — and therefore
   * spend a model call — so this is what attributes that call to the step that paid for it.
   */
  executionId?: string
}

export interface FragmentLibraryServiceDependencies {
  promptFragmentRepository: PromptFragmentRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Where this service REPORTS what it dropped. Optional and normalised once to `noopLogger`, so
   * the service stays unit-testable standalone while a facade always wires the real one.
   *
   * It had none at all, and that is why an unresolvable standing-context id was invisible: an
   * operation meant to fold three standards folded two, forever, on every run, and the only trace
   * anywhere was one boot WARNING that cannot tell a typo from a legitimate tenant-tier id.
   */
  logger?: Logger
  /**
   * Where the same drop is COUNTED. Optional and normalised once to `noopOperationalMetrics`,
   * beside the logger and for the same reason.
   *
   * The log line answers "what did THIS run go without"; only the counter answers "is this
   * happening more than it was", and every shape that produces a drop is a standing condition
   * rather than an incident (a package resolved twice, a typo'd id pinned by a task type, a
   * mothership build that moved). An operator who has to notice those in per-run logs does not
   * notice them.
   */
  operationalMetrics?: OperationalMetrics
  /** Relevance selector; defaults to the deterministic matcher when omitted. */
  selector?: FragmentSelector
  /**
   * Where the built-in catalog tier is READ from: the app-owned {@link PromptFragmentSource}:
   * this deployment's own registry, or the MOTHERSHIP's on a mothership-mode node. Read per
   * catalog resolve, so a registration made at startup is part of the merged tenant catalog
   * whatever the construction order, and can be shadowed or tombstoned per tier like every
   * other built-in.
   *
   * Absent (a direct test construction, or a caller with no registry in hand) ⇒ the tier is
   * EMPTY. Deliberately not a silent fall-back to the shipped module catalog: this used to read a
   * module global, and a caller that forgot to wire it was indistinguishable from one whose
   * deployment registered nothing.
   */
  promptFragmentSource?: PromptFragmentSource
  /** Built-in catalog tier as a fixed list, for tests that want no source at all. */
  builtins?: PromptFragment[]
  /**
   * Live document reader for document-backed fragments. When absent the feature
   * is off: creating/refreshing a document fragment throws, and run resolution
   * uses each entry's last-resolved `body` unchanged.
   */
  documentContentResolver?: DocumentContentResolver
  /**
   * Read-through cache for the merged tenant catalog (`AppCaches.fragmentCatalog`,
   * docs/initiatives/caching-layer.md slice 1), grouped by workspace id. This
   * service owns its coherence: every fragment write below invalidates through
   * {@link FragmentLibraryService.invalidateCatalogTier}. Absent (direct test
   * construction) ⇒ every resolve loads from the repositories.
   */
  catalogCache?: GroupCacheHandle<ResolvedCatalogEntry[]>
  /**
   * Read-through cache for a document-backed fragment's live external body
   * (`AppCaches.fragmentDocumentBody`, docs/initiatives/caching-layer.md slice 2),
   * grouped by the connection workspace and keyed per document. Self-verifying: an
   * entry entering its refresh window runs the source's cheap version probe and
   * keeps the cached body when the page hasn't moved, so a run reads the body
   * without blocking on a live page fetch. Absent (direct test construction) ⇒ a
   * run serves the last-persisted body and does NOT re-resolve live (the durable
   * `prompt_fragments.body`, refreshed only by an explicit create/refresh, is the
   * fallback).
   */
  documentBodyCache?: GroupCacheHandle<DocumentContent>
  /**
   * Resolves (and, for a long standard with no linked short version, generates) the
   * condensed variant an implementer dispatch folds. Absent ⇒ only AUTHORED briefs are
   * folded and every other long standard is sent in full, which is the pre-feature
   * behaviour rather than a degraded one.
   */
  briefService?: FragmentBriefService
}

/**
 * The fragment library's management service (ADR 0006). It owns the per-tier CRUD
 * (account / workspace) and resolves the merged catalog a workspace sees (built-in ∪
 * account ∪ workspace, override-by-id, tombstone-suppressed). The execution engine
 * consumes it at run time through {@link resolveBodiesForRun} (wired as the engine's
 * `fragmentResolver`), so managed and document-backed fragments actually reach a
 * `code-aware` step; the automatic per-run relevance selector ({@link resolveForRun})
 * is a management-surface leftover the run path no longer drives.
 */
export class FragmentLibraryService implements FragmentResolver {
  private readonly repo: PromptFragmentRepository
  private readonly workspaces: WorkspaceRepository
  private readonly clock: Clock
  private readonly selector: FragmentSelector
  private readonly builtinsOverride?: PromptFragment[]
  private readonly fragmentSource?: PromptFragmentSource
  private readonly log: Logger
  private readonly metrics: OperationalMetrics
  private readonly documentResolver?: DocumentContentResolver
  private readonly catalogCache?: GroupCacheHandle<ResolvedCatalogEntry[]>
  private readonly documentBodyCache?: GroupCacheHandle<DocumentContent>
  private readonly briefs?: FragmentBriefService

  constructor(deps: FragmentLibraryServiceDependencies) {
    this.repo = deps.promptFragmentRepository
    this.workspaces = deps.workspaceRepository
    this.clock = deps.clock
    this.selector = deps.selector ?? new DeterministicFragmentSelector()
    this.builtinsOverride = deps.builtins
    this.fragmentSource = deps.promptFragmentSource
    this.log = deps.logger ?? noopLogger
    this.metrics = deps.operationalMetrics ?? noopOperationalMetrics
    this.documentResolver = deps.documentContentResolver
    this.catalogCache = deps.catalogCache
    this.documentBodyCache = deps.documentBodyCache
    this.briefs = deps.briefService
  }

  /**
   * The built-in tier: the injected fixed list, else the app-owned SOURCE, read per resolve so
   * registrations made at startup are seen regardless of construction order.
   *
   * Async because one implementation crosses a network (a mothership-mode node reads the pool
   * from the mothership), and that read THROWS rather than answering empty. An unreachable
   * mothership and a deployment with no standards are the same value and opposite facts. The
   * throw propagates: this is the catalog every tier merges onto, so swallowing it here would
   * serve a catalog silently missing the deployment's whole standards library.
   */
  private async builtins(): Promise<PromptFragment[]> {
    if (this.builtinsOverride) return this.builtinsOverride
    return (await this.fragmentSource?.all()) ?? []
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
      brief: input.brief?.trim() || null,
      appliesTo: input.appliesTo ?? null,
      tags: input.tags && input.tags.length ? input.tags : null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.repo.upsert(record)
    await this.invalidateCatalogTier(ownerKind, ownerId)
    return recordToWire(record)
  }

  /**
   * Link an external document (Confluence/Notion page or GitHub file) as a
   * **living** fragment at a tier. Fetches the page now to seed the catalog entry
   * (title/body/summary) and stores its `documentRef` so run-time resolution can
   * re-read it. The fetch goes through `fetchViaWorkspaceId`'s stored connection —
   * the addressed workspace for a workspace-tier link, or the caller-supplied
   * `viaWorkspaceId` for an account-tier link.
   */
  async createFromDocument(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    input: CreateDocumentFragmentInput,
    fetchViaWorkspaceId: string,
  ): Promise<PromptFragment> {
    if (!this.documentResolver) {
      throw new ValidationError('The document-source integration is not configured')
    }
    const content = await this.documentResolver.fetch(fetchViaWorkspaceId, input.source, input.ref)
    const fragmentId = (input.id ?? slugFromPath(content.title)).trim()
    if (!fragmentId) {
      throw new ValidationError('A fragment id (or a document with a non-empty title) is required')
    }
    const now = this.clock.now()
    const record: PromptFragmentRecord = {
      fragmentId,
      ownerKind,
      ownerId,
      version: '1.0.0',
      title: content.title,
      category: input.category?.trim() || null,
      summary: buildExcerpt(content.body),
      body: content.body,
      // A living document supplies no short version of itself, so a long page is condensed
      // automatically — and re-condensed each time the page moves, since the stored brief is
      // fingerprinted against the body that produced it.
      brief: null,
      appliesTo: input.appliesTo ?? null,
      tags: input.tags && input.tags.length ? input.tags : null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      docSource: input.source,
      docExternalId: content.externalId,
      docViaWorkspaceId: fetchViaWorkspaceId,
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.repo.upsert(record)
    await this.invalidateCatalogTier(ownerKind, ownerId)
    await this.invalidateDocumentBody(record)
    return recordToWire(record)
  }

  /**
   * Force an immediate live re-resolve of a document-backed fragment (the UI
   * "refresh now" action), bypassing the TTL. No-op-ish for a non-document
   * fragment (throws). Throws if the fetch fails so the caller sees the error.
   */
  async refresh(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
    viaWorkspaceId: string,
  ): Promise<PromptFragment> {
    if (!this.documentResolver) {
      throw new ValidationError('The document-source integration is not configured')
    }
    const existing = await this.repo.get(ownerKind, ownerId, fragmentId)
    if (!existing || existing.deletedAt !== null) {
      throw new ValidationError(`Fragment '${fragmentId}' was not found`)
    }
    if (!existing.docSource || existing.docExternalId === null) {
      throw new ValidationError(`Fragment '${fragmentId}' is not document-backed`)
    }
    const content = await this.documentResolver.fetch(
      viaWorkspaceId,
      existing.docSource,
      existing.docExternalId,
    )
    const now = this.clock.now()
    const next: PromptFragmentRecord = {
      ...existing,
      title: content.title,
      summary: buildExcerpt(content.body),
      body: content.body,
      docExternalId: content.externalId,
      // Remember the connection this refresh succeeded through, so run-time
      // re-resolution keeps using it (matters for an account-tier fragment).
      docViaWorkspaceId: viaWorkspaceId,
      resolvedAt: now,
      updatedAt: now,
    }
    await this.repo.upsert(next)
    await this.invalidateCatalogTier(ownerKind, ownerId)
    await this.invalidateDocumentBody(next)
    return recordToWire(next)
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
      brief: null,
      appliesTo: null,
      tags: null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
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
      // An explicit `''` UNLINKS the short version (handing the fragment back to
      // auto-generation); omitting the key leaves whatever was linked before.
      brief: patch.brief !== undefined ? patch.brief.trim() || null : base.brief,
      appliesTo: patch.appliesTo !== undefined ? patch.appliesTo : base.appliesTo,
      tags: patch.tags !== undefined ? (patch.tags.length ? patch.tags : null) : base.tags,
      updatedAt: now,
      deletedAt: null, // editing un-suppresses
    }
    if (!next.summary || !next.body) {
      throw new ValidationError('A fragment needs a summary and a body')
    }
    await this.repo.upsert(next)
    await this.invalidateCatalogTier(ownerKind, ownerId)
    await this.invalidateDocumentBody(next)
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
      await this.invalidateCatalogTier(ownerKind, ownerId)
      await this.invalidateDocumentBody(existing)
      // The generated brief condenses a body this tier no longer serves — drop it with the
      // fragment rather than leaving derived text behind a tombstone.
      await this.briefs?.forget(ownerKind, ownerId, fragmentId)
      return
    }
    // A pure tombstone over an INHERITED id (no row of this tier's own to delete). Nothing to
    // forget here on purpose: any generated brief for that id belongs to the tier that still
    // owns it — a built-in's lives at the account scope — and suppressing it on one board must
    // not delete the condensation its siblings are still folding.
    await this.repo.upsert({
      fragmentId,
      ownerKind,
      ownerId,
      version: '1.0.0',
      title: fragmentId,
      category: null,
      summary: '',
      body: '',
      brief: null,
      appliesTo: null,
      tags: null,
      sourceId: null,
      sourcePath: null,
      sourceSha: null,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    })
    await this.invalidateCatalogTier(ownerKind, ownerId)
  }

  /**
   * Resolve the merged catalog a workspace sees (built-in ∪ account ∪ workspace).
   * Served through the fragment-catalog cache when wired — this runs on every
   * agent dispatch (and again on each poll tick that re-enters context assembly),
   * so a hit skips the tenant reads + merge entirely. The key is just the
   * workspace id (its account is resolved inside the load): a workspace never
   * changes accounts, and keying by account would force an extra read per hit.
   */
  async resolveCatalog(workspaceId: string): Promise<ResolvedCatalogEntry[]> {
    if (!this.catalogCache) return this.loadCatalog(workspaceId)
    return this.catalogCache.get(workspaceId, workspaceId, () => this.loadCatalog(workspaceId))
  }

  /** The uncached tenant merge {@link resolveCatalog} reads through the cache. */
  private async loadCatalog(workspaceId: string): Promise<ResolvedCatalogEntry[]> {
    const accountId = await this.workspaces.accountOf(workspaceId)
    const [accountRows, workspaceRows] = await Promise.all([
      accountId ? this.repo.listByOwner('account', accountId, true) : Promise.resolve([]),
      this.repo.listByOwner('workspace', workspaceId, true),
    ])
    return mergeCatalog(await this.builtins(), accountRows, workspaceRows, {
      accountId: accountId ?? null,
      workspaceId,
    })
  }

  /**
   * Drop the cached merged catalog for every workspace a tier write affects —
   * called after each fragment write here (and by the source-sync service via its
   * injected hook). A workspace-tier write is one group eviction; an account-tier
   * write affects every workspace in the account, so it clears the whole cache
   * (deliberately coarse — account writes are rare management actions, and
   * enumerating the account's workspaces on every one would cost more than the
   * repopulation it saves). Peers drop their entries via the notification bus.
   */
  async invalidateCatalogTier(ownerKind: FragmentOwnerKind, ownerId: string): Promise<void> {
    if (!this.catalogCache) return
    if (ownerKind === 'workspace') {
      await this.catalogCache.invalidateGroup(ownerId)
    } else {
      await this.catalogCache.invalidateAll()
    }
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
        workspaceId: input.workspaceId,
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
      fragments: ordered.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        ...(e.brief ? { brief: e.brief } : {}),
      })),
      selectedIds: ordered.map((e) => e.id),
    }
  }

  /**
   * Resolve a set of already-selected fragment ids to their bodies against the
   * merged tenant catalog (built-in ∪ account ∪ workspace) — this is what the
   * execution engine drives instead of the static `getFragment` map, so managed
   * fragments actually reach a run. For a **document-backed** entry whose cached
   * body is stale (older than the TTL), it live-fetches the page's current
   * content via the document resolver, persists the refreshed body, and uses it;
   * any fetch failure falls back to the last-resolved `body` so a run never
   * blocks. Ids absent from the catalog are dropped — deliberately with NO static
   * fallback: the built-in tier already includes every deployment-registered
   * fragment, so a missing id is either stale or tier-tombstoned, and resolving it
   * from the static pool anyway would defeat suppression (ADR 0006). The result
   * preserves the input order.
   *
   * A caller that has already resolved the merged catalog (e.g. to also read titles)
   * may pass `options.catalog` to avoid a second resolve of the same tenant catalog.
   *
   * Under `options.verbosity: 'brief'` — an implementer dispatch — each standard also
   * resolves the CONDENSED variant the prompt composer will fold in place of its body:
   * the winning tier's linked `brief`, else a persisted model-generated one, generating
   * (and storing) it here when a long standard has none or when the stored one condensed
   * a body this fragment no longer has. See {@link FragmentBriefService}.
   */
  async resolveBodiesForRun(
    workspaceId: string,
    ids: string[],
    options: ResolveBodiesOptions = {},
  ): Promise<{ id: string; title: string; body: string; brief?: string }[]> {
    if (ids.length === 0) return []
    const entries = options.catalog ?? (await this.resolveCatalog(workspaceId))
    const byId = new Map(entries.map((e) => [e.id, e]))

    const resolved: { entry: ResolvedCatalogEntry; body: string }[] = []
    const seen = new Set<string>()
    const dropped: string[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const entry = byId.get(id)
      if (!entry) {
        dropped.push(id)
        continue
      }
      const body = entry.documentRef
        ? await this.resolveDocumentBody(workspaceId, entry)
        : entry.body
      resolved.push({ entry, body })
    }
    // Every cap records what it dropped. Silently skipping these is why a mis-typed
    // `defaultFragmentIds` entry (or a deployment running two physical copies of the fragment
    // package, which resolves the whole registered pool to nothing) cost a run's standards on EVERY
    // run with no signal anywhere: the boot warning fires once, cannot distinguish a typo from a
    // tenant-tier id, and says nothing at all about the run that just went without.
    //
    // A WARN rather than a refusal, because dropping is the correct behaviour: a tombstoned or
    // superseded id must not resolve, and re-adding a static fallback would defeat suppression
    // (ADR 0006). What was missing is the report, not the disposition.
    if (dropped.length > 0) {
      // The message states what was OBSERVED (the id is not in the merged catalog) and names the
      // causes it cannot separate, rather than asserting the one that needs a fix. A tombstoned
      // built-in reaches this line identically to a typo, and calling that "resolves against
      // nothing" would report a workspace's own deliberate suppression as a defect on every run
      // it makes. Separating them takes the tier ROWS, and only the merged entries survive the
      // catalog cache this reads through, so the honest split is not available here for free.
      this.log.warn(
        'Standing-context fragments were dropped from a run: these ids are not in the ' +
          "workspace's merged fragment catalog, so the guidance they name did not reach the " +
          'agent. Either the id resolves against nothing (a typo, or a deployment whose ' +
          'registered pool is empty), or this tier deliberately suppressed it',
        {
          workspaceId,
          droppedFragmentIds: dropped,
          ...(options.executionId ? { executionId: options.executionId } : {}),
        },
      )
      // Per FRAGMENT, not per run: a run pinning five ids against an empty pool is five times as
      // short of its standards as one carrying a single typo.
      this.metrics.increment('fragments.dropped_from_run', undefined, dropped.length)
    }

    // Only an implementer dispatch folds condensed variants, so only it pays to resolve
    // them; every other kind gets full bodies and never triggers a condensation.
    const briefs =
      options.verbosity === 'brief' && this.briefs
        ? await this.briefs.resolveBriefs(
            workspaceId,
            resolved,
            options.executionId ? { executionId: options.executionId } : {},
          )
        : new Map<string, string>()

    // Carry the human title so the prompt composer can render each standard as its own labelled
    // block (and a code/PR reviewer can cite it by title in its adherence report), plus the brief
    // resolved ALONGSIDE this body — never re-looked-up by id downstream, so a tenant override's
    // body can never be paired with a built-in's condensed text.
    return resolved.map(({ entry, body }) => {
      const brief = briefs.get(entry.id) ?? entry.brief ?? undefined
      return { id: entry.id, title: entry.title, body, ...(brief ? { brief } : {}) }
    })
  }

  /**
   * The live body for a document-backed catalog entry, served through the
   * document-body cache: on a cache miss it fetches from the source; an entry
   * entering its refresh window runs the source's cheap version probe and keeps the
   * cached body when the page hasn't moved (else a background reload). The read
   * never blocks on a live fetch once warm, and a failed fetch degrades to the
   * entry's last-persisted `body`. Without a cache wired the live re-resolve is
   * off — the durable persisted body (refreshed only by an explicit create/refresh)
   * is served as-is, since the freshness mechanism lives in the cache.
   */
  private async resolveDocumentBody(
    workspaceId: string,
    entry: ResolvedCatalogEntry,
  ): Promise<string> {
    const ref = entry.documentRef
    if (!ref || !this.documentResolver || entry.tier === 'builtin') return entry.body
    if (!this.documentBodyCache) return entry.body
    const resolver = this.documentResolver
    // The connection workspace the body is cached + invalidated under. For a
    // workspace-tier fragment that is its owning workspace (== the run's own). For an
    // account-tier fragment it MUST be the recorded connection workspace, NOT the run's:
    // the run can be any of the account's workspaces, so keying on it would fan the same
    // document across N groups a later edit could never all invalidate. A legacy account
    // row with none recorded can't be keyed stably, so it serves the durable persisted
    // body — matching `invalidateDocumentBody`, which also skips it (best-effort).
    const via = entry.docViaWorkspaceId ?? (entry.tier === 'account' ? null : workspaceId)
    if (!via) return entry.body
    try {
      const content = await this.documentBodyCache.get(
        documentBodyKey(ref.source, ref.externalId),
        via,
        () => resolver.fetch(via, ref.source, ref.externalId),
        async (cached) => {
          // An empty version token means the source exposes no version to compare, so the
          // probe can't confirm freshness — treat it as stale so the entry falls through
          // to a real reload (bounded by the TTL) instead of being pinned forever.
          if (!cached.version) return false
          return (await resolver.probeVersion(via, ref.source, ref.externalId)) === cached.version
        },
      )
      return content.body
    } catch {
      return entry.body // source unreachable → last-resolved body keeps the run going
    }
  }

  /**
   * Drop a document-backed fragment's cached live body after an explicit write
   * (create/refresh/edit/remove) so the next run re-resolves it immediately rather
   * than waiting out the refresh window. Best-effort: the cache is self-verifying
   * via the version probe, so a group we can't resolve (a legacy row with no
   * recorded connection workspace) simply relies on the probe/TTL instead. Peers
   * drop their entry via the notification bus.
   */
  private async invalidateDocumentBody(record: PromptFragmentRecord): Promise<void> {
    if (!this.documentBodyCache || !record.docSource || record.docExternalId === null) return
    const via =
      record.docViaWorkspaceId ?? (record.ownerKind === 'workspace' ? record.ownerId : null)
    if (!via) return
    await this.documentBodyCache.invalidate(
      documentBodyKey(record.docSource, record.docExternalId),
      via,
    )
  }
}

/** The document-body cache key: one entry per source document, within a workspace group. */
function documentBodyKey(source: DocumentSourceKind, externalId: string): string {
  return `${source}:${externalId}`
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
  if (record.brief) fragment.brief = record.brief
  if (record.appliesTo) fragment.appliesTo = record.appliesTo
  if (record.tags && record.tags.length) fragment.tags = record.tags
  if (record.sourceId && record.sourcePath !== null && record.sourceSha !== null) {
    fragment.source = { sourceId: record.sourceId, path: record.sourcePath, sha: record.sourceSha }
  }
  if (record.docSource && record.docExternalId !== null) {
    fragment.documentRef = { source: record.docSource, externalId: record.docExternalId }
  }
  if (record.resolvedAt !== null) fragment.resolvedAt = record.resolvedAt
  return fragment
}
