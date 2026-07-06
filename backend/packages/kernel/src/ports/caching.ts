import type { GitHubRepo, ModelFamilyPolicy } from '../domain/types.js'
import type { DocumentContent } from './document-source.js'
import type { ResolvedCatalogEntry } from './fragment-repositories.js'

// ---------------------------------------------------------------------------
// The app-level caching seam (docs/initiatives/caching-layer.md). Services read
// slow-moving data through a named handle's read-through `get`, and every write
// path that mutates the cached source invalidates it afterwards. The production
// implementation (`@cat-factory/caching`, built on layered-loader) keeps each
// replica's entries in memory only and — in multi-node Node deployments —
// broadcasts invalidations to peers over a Redis notification channel; these
// interfaces keep the domain/service layer free of that machinery.
// ---------------------------------------------------------------------------

/**
 * A named, workspace-groupable read-through cache. `get` returns the cached
 * value for `(key, group)` or runs `load` (deduplicating concurrent loads of the
 * same key) and caches its result. Groups exist so one workspace-wide event can
 * drop every entry for that workspace in a single `invalidateGroup` call.
 */
export interface GroupCacheHandle<T> {
  /**
   * `isStillCurrent` is the optional cheap staleness probe for git-backed caches
   * (a sha/hash compare, strictly cheaper than `load`): when the cache's profile
   * configures a preemptive-refresh window, an entry entering that window runs
   * the probe in the background and gets its TTL bumped on `true` instead of
   * paying the full reload. Omitted (or no window configured) ⇒ entries in the
   * window fall back to a full background reload.
   */
  get(
    key: string,
    group: string,
    load: () => Promise<T>,
    isStillCurrent?: (cached: T) => Promise<boolean>,
  ): Promise<T>
  /** Drop one entry (and broadcast the eviction to peer replicas, when wired). */
  invalidate(key: string, group: string): Promise<void>
  /** Drop every entry in a group (one workspace, typically). */
  invalidateGroup(group: string): Promise<void>
  /**
   * Drop everything. The deliberate coarse fallback for rare writes whose blast
   * radius spans many groups (e.g. an account-tier write affecting every
   * workspace in the account) — over-invalidation is always safe.
   */
  invalidateAll(): Promise<void>
}

/**
 * The app-owned bag of named caches, one per adopted slice of the caching
 * initiative. Built once per process by a facade (`createAppCaches`) and
 * threaded through the dependency bag; consuming services take their handle off
 * it. A cache configured as pass-through (the Worker's isolate-safe profile for
 * mutable cross-instance state) satisfies the same interface — every `get` just
 * runs `load`.
 */
export interface AppCaches {
  /** The merged per-workspace prompt-fragment catalog, grouped by workspace id. */
  fragmentCatalog: GroupCacheHandle<ResolvedCatalogEntry[]>
  /**
   * The live body of a document-backed prompt fragment (the external
   * Confluence/Notion/GitHub/… page), grouped by the workspace whose connection
   * fetches it and keyed by `<source>:<externalId>`. A self-verifying cache: an
   * entry entering its refresh window runs the source's cheap version probe and
   * keeps its cached body when the page hasn't moved, so an agent run reads a
   * fragment body without blocking on a live page fetch. Explicit writes (a
   * fragment refresh/edit) invalidate it directly.
   */
  fragmentDocumentBody: GroupCacheHandle<DocumentContent>
  /**
   * The workspace's GitHub repo projection (`repoProjectionRepository.list`),
   * grouped AND keyed by workspace id — the whole-projection re-list the
   * block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
   * every durable poll tick (docs/initiatives/caching-layer.md slice 3). Coherence
   * is invalidation-driven: every projection write (GitHub sync/webhook tombstone,
   * repo link/monorepo-flag, bootstrap projection) drops the workspace group after
   * the write commits. The installation lookup and the (tree-depth-bounded) block
   * ancestry walk stay live, so a reparent or service repo-link change needs no
   * invalidation. Pass-through on the Worker's isolate-safe profile (our own mutable
   * D1 state, no cross-isolate bus), so it caches only on the Node/local facades.
   */
  repoProjection: GroupCacheHandle<GitHubRepo[]>
  /**
   * The account's resolved model-family allow/block policy (`AccountSettingsService`'s
   * non-secret config), grouped AND keyed by account id — the slow-moving, admin-changed
   * read `resolveWorkspaceCapabilities` runs on every `/models` call and every pipeline
   * start guard. Wrapped ({@link AccountModelPolicyCacheValue}) so the common "no policy"
   * case caches as a value rather than a re-loaded null. Coherence is invalidation-driven:
   * the sole write path (the account-settings update controller) drops the account's entry
   * after the write commits. Pass-through on the Worker's isolate-safe profile (our own
   * mutable D1 state, no cross-isolate bus), so it caches only on the Node/local facades.
   */
  accountModelPolicy: GroupCacheHandle<AccountModelPolicyCacheValue>
  /** Release notification-bus resources (a no-op for bare in-memory caches). */
  close(): Promise<void>
}

/** Cache-friendly wrapper for the account policy read (`null` ⇒ no policy / `off`). */
export interface AccountModelPolicyCacheValue {
  policy: ModelFamilyPolicy | null
}
