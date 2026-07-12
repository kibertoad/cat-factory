import type {
  AccountModelPolicyCacheValue,
  AppCaches,
  BudgetLimitCacheValue,
  CachedRepoRead,
  DocumentContent,
  GitHubRepo,
  GroupCacheHandle,
  ResolvedCatalogEntry,
  WorkspaceSettingsCacheValue,
} from '@cat-factory/kernel'
// Deep imports on purpose: layered-loader's root index eagerly requires its Redis
// modules (and thereby `ioredis`), which must never load outside the Node facade's
// REDIS_URL-gated notification wiring — the Worker imports this package too. The
// non-Redis modules below pull in only in-memory machinery.
import { GroupLoader } from 'layered-loader/dist/lib/GroupLoader.js'
import type { AbstractNotificationConsumer } from 'layered-loader/dist/lib/notifications/AbstractNotificationConsumer.js'
import type { GroupNotificationPublisher } from 'layered-loader/dist/lib/notifications/GroupNotificationPublisher.js'
import type { InMemoryGroupCache } from 'layered-loader/dist/lib/memory/InMemoryGroupCache.js'
import type { Logger } from 'layered-loader/dist/lib/util/Logger.js'

// The layered-loader implementation of the kernel `AppCaches` port
// (docs/initiatives/caching-layer.md). Every cache is IN-MEMORY ONLY: each
// replica holds its own LRU and repopulates from its data source on miss. Redis
// never carries values — in a multi-node Node deployment the injected
// notification pair broadcasts invalidation KEYS so peers drop their entries;
// with no pair injected (single replica, local mode, tests) the loaders are bare
// in-memory with zero extra dependency.

/** Per-cache tuning knobs; a facade passes a profile so TTLs can differ per runtime. */
export interface GroupCacheProfile {
  /**
   * `false` ⇒ pass-through: no in-memory tier is built and every read runs its
   * load. The Worker's isolate-safe stance for caches of MUTABLE cross-instance
   * state — an isolate has no cross-isolate invalidation bus, so a TTL'd cache
   * there would serve stale data after a write on another isolate.
   */
  enabled: boolean
  /** Entry freshness backstop; invalidation, not the TTL, is the coherence story. */
  ttlInMsecs: number
  /** LRU bound on distinct groups (workspaces, typically). */
  maxGroups: number
  /** LRU bound on entries within one group. */
  maxItemsPerGroup: number
  /**
   * Preemptive-refresh window for git-backed caches (layered-loader ≥ 14.5.3
   * supports it in-memory-only): an entry hit with less than this much TTL left
   * refreshes in the background — via the caller's cheap `isStillCurrent` probe
   * (TTL bump when the source hasn't moved) when one is passed to `get`, else a
   * full background reload. Unset ⇒ entries simply expire at `ttlInMsecs`
   * (correct for the invalidation-driven DB-backed caches, where a probe would
   * cost as much as the load).
   */
  ttlLeftBeforeRefreshInMsecs?: number
}

/** One profile entry per named cache in the kernel {@link AppCaches} bag. */
export interface AppCachesProfile {
  fragmentCatalog: GroupCacheProfile
  fragmentDocumentBody: GroupCacheProfile
  repoProjection: GroupCacheProfile
  repoFiles: GroupCacheProfile
  accountModelPolicy: GroupCacheProfile
  workspaceSettings: GroupCacheProfile
  accountBudgetLimit: GroupCacheProfile
  userBudgetLimit: GroupCacheProfile
}

/** The default (Node/local/test) profile: caching on, modest bounds. */
export const DEFAULT_APP_CACHES_PROFILE: AppCachesProfile = {
  // One merged catalog per workspace; the key varies only when the workspace's
  // account changes, so a small per-group bound is plenty.
  fragmentCatalog: { enabled: true, ttlInMsecs: 5 * 60_000, maxGroups: 500, maxItemsPerGroup: 4 },
  // The live external body of a document-backed fragment, grouped by workspace and
  // keyed per document. Self-verifying: an entry entering the last minute of its TTL
  // runs the source's cheap version probe (bump on unchanged, background reload on
  // change) so a run never blocks on a live page fetch.
  fragmentDocumentBody: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 500,
    maxItemsPerGroup: 64,
    ttlLeftBeforeRefreshInMsecs: 60_000,
  },
  // One repo-projection list per workspace, keyed by workspace id (so exactly one
  // entry per group). Invalidation-driven — no version probe (a DB read as the probe
  // would cost as much as the DB read as the load).
  repoProjection: { enabled: true, ttlInMsecs: 5 * 60_000, maxGroups: 1000, maxItemsPerGroup: 1 },
  // Checkout-free RepoFiles reads, grouped per (installation, repo, branch) and keyed per
  // path. Self-verifying like the document body: an entry entering the last minute of its
  // TTL runs the branch's cheap `headSha` probe (bump on an unmoved branch, background
  // reload otherwise) so a repo-op re-run doesn't re-fetch every file. A branch can hold
  // many spec/blueprint shards, so a generous per-group bound.
  repoFiles: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 500,
    maxItemsPerGroup: 256,
    ttlLeftBeforeRefreshInMsecs: 60_000,
  },
  // One resolved model-family policy per account, keyed by account id (one entry per
  // group). Slow-moving (admin-changed); invalidation-driven, no version probe.
  accountModelPolicy: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 2000,
    maxItemsPerGroup: 1,
  },
  // One workspace-settings row per workspace, keyed by workspace id (one entry per group).
  // Slow-moving (admin-changed); invalidation-driven, no version probe. Read on several hot
  // paths (per-LLM-call body gate, per-step task-limit guard, per-call spend pricing).
  workspaceSettings: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 1000,
    maxItemsPerGroup: 1,
  },
  // One configured budget limit per account, keyed by account id (one entry per group).
  // Slow-moving; invalidation-driven, no version probe.
  accountBudgetLimit: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 2000,
    maxItemsPerGroup: 1,
  },
  // One configured budget limit per user, keyed by user id (one entry per group).
  userBudgetLimit: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 5000,
    maxItemsPerGroup: 1,
  },
}

/**
 * The Cloudflare Worker profile: every cache of mutable cross-instance state is
 * pass-through, because a Worker isolate has no cross-isolate invalidation bus
 * (and no Redis) — see the package README. Caches of immutable or self-verifying
 * entries (sha-pinned reads, static catalogs) may enable real TTLs here.
 *
 * `fragmentDocumentBody` stays ENABLED here: its entries are external page content
 * re-validated by a cheap version probe, so a peer isolate's cached body self-heals
 * within the refresh window without an invalidation bus (the same reasoning that
 * lets sha-pinned reads keep a TTL on the Worker) — its staleness is bounded by the
 * probe, not indefinite. Only `fragmentCatalog`, which mirrors our own mutable D1
 * state, must pass through.
 */
export const ISOLATE_SAFE_APP_CACHES_PROFILE: AppCachesProfile = {
  fragmentCatalog: { ...DEFAULT_APP_CACHES_PROFILE.fragmentCatalog, enabled: false },
  fragmentDocumentBody: { ...DEFAULT_APP_CACHES_PROFILE.fragmentDocumentBody },
  // Pass-through: the repo projection is our own mutable D1 state, and a Worker
  // isolate has no cross-isolate invalidation bus (unlike `fragmentDocumentBody`,
  // whose external entries self-verify via a version probe). So the Worker reads it
  // live every time, exactly like `fragmentCatalog`.
  repoProjection: { ...DEFAULT_APP_CACHES_PROFILE.repoProjection, enabled: false },
  // Stays ENABLED here: a RepoFiles branch read is re-validated by the branch `headSha`
  // probe (the git analogue of the document-body version probe), so a peer isolate's cached
  // file self-heals within the refresh window without an invalidation bus — its staleness is
  // bounded by the probe, not indefinite. The same reasoning that keeps `fragmentDocumentBody`
  // on; only caches of our own mutable D1 state (`fragmentCatalog`/`repoProjection`) pass through.
  repoFiles: { ...DEFAULT_APP_CACHES_PROFILE.repoFiles },
  // Pass-through for the same reason: the account policy is our own mutable D1 state
  // with no cross-isolate invalidation bus on the Worker.
  accountModelPolicy: { ...DEFAULT_APP_CACHES_PROFILE.accountModelPolicy, enabled: false },
  // Pass-through: the workspace-settings row and the budget-limit reads are all our own
  // mutable D1 state with no cross-isolate invalidation bus on the Worker, so the isolate
  // reads them live (the Worker rebuilds the bag per invocation, so a within-invocation
  // read still dedupes) — same class as `repoProjection`/`accountModelPolicy`.
  workspaceSettings: { ...DEFAULT_APP_CACHES_PROFILE.workspaceSettings, enabled: false },
  accountBudgetLimit: { ...DEFAULT_APP_CACHES_PROFILE.accountBudgetLimit, enabled: false },
  userBudgetLimit: { ...DEFAULT_APP_CACHES_PROFILE.userBudgetLimit, enabled: false },
}

/**
 * A per-cache invalidation-notification pair (layered-loader's group publisher +
 * consumer). Produced by the facade's factory — Redis-backed in a multi-node Node
 * deployment, a fake sharing an in-memory bus in tests.
 */
export interface GroupCacheNotifications<T> {
  publisher: GroupNotificationPublisher<T>
  consumer: AbstractNotificationConsumer<T, InMemoryGroupCache<T>>
}

/**
 * Builds the notification pair for one named cache (each cache gets its own
 * channel, `<prefix>:<cacheName>`). Returning `undefined` leaves that cache bare
 * in-memory. The factory is per-CACHE so a facade can wire dedicated clients per
 * channel — layered-loader closes a pair's clients with its loader.
 */
export type GroupNotificationPairFactory = <T>(
  cacheName: string,
) => GroupCacheNotifications<T> | undefined

export interface CreateAppCachesOptions {
  /** Per-cache overrides merged over {@link DEFAULT_APP_CACHES_PROFILE}. */
  profile?: Partial<AppCachesProfile>
  /** Absent ⇒ bare in-memory loaders (single replica, local mode, tests). */
  notificationPairFactory?: GroupNotificationPairFactory
  /** Error sink for background cache/notification failures (a pino logger fits). */
  logger?: Logger
}

/**
 * The load params threaded through the loader; the caller supplies the load —
 * and, for probe-refreshed caches, the staleness probe — per read.
 */
interface GroupLoadParams<T> {
  key: string
  load: () => Promise<T>
  isStillCurrent?: (cached: T) => Promise<boolean>
}

class LayeredGroupCacheHandle<T> implements GroupCacheHandle<T> {
  private readonly loader: GroupLoader<T, GroupLoadParams<T>>

  constructor(
    name: string,
    profile: GroupCacheProfile,
    notifications: GroupCacheNotifications<T> | undefined,
    logger: Logger | undefined,
  ) {
    this.loader = new GroupLoader<T, GroupLoadParams<T>>({
      inMemoryCache: profile.enabled
        ? {
            cacheId: name,
            cacheType: 'lru-object',
            groupCacheType: 'lru-object',
            ttlInMsecs: profile.ttlInMsecs,
            maxGroups: profile.maxGroups,
            maxItemsPerGroup: profile.maxItemsPerGroup,
            ...(profile.ttlLeftBeforeRefreshInMsecs
              ? { ttlLeftBeforeRefreshInMsecs: profile.ttlLeftBeforeRefreshInMsecs }
              : {}),
          }
        : false,
      // The read-through source: each `get` carries its own load closure, so the
      // owning service keeps its load logic and the loader keeps in-flight dedup.
      dataSources: [
        {
          name: `${name}-load`,
          getFromGroup: (params: GroupLoadParams<T>) => params.load(),
          getManyFromGroup: () =>
            Promise.reject(new Error(`cache '${name}' does not support getMany`)),
        },
      ],
      cacheKeyFromLoadParamsResolver: (params) => params.key,
      // The staleness probe rides the per-read load params, like the load itself.
      // Wired only when the profile configures a refresh window (layered-loader
      // rejects a probe with no window to fire in); a read that passed no probe
      // reports stale, degrading to the default full background reload. A null
      // cached value (resolved-but-empty) is re-loaded rather than probed.
      ...(profile.enabled && profile.ttlLeftBeforeRefreshInMsecs
        ? {
            isEntryStillCurrentFn: (cached: T | null, params: GroupLoadParams<T>) =>
              cached !== null && params.isStillCurrent
                ? params.isStillCurrent(cached)
                : Promise.resolve(false),
          }
        : {}),
      // A notification pair only makes sense with an in-memory tier to invalidate
      // (layered-loader rejects the combination outright).
      ...(profile.enabled && notifications
        ? {
            notificationConsumer: notifications.consumer,
            notificationPublisher: notifications.publisher,
          }
        : {}),
      ...(logger ? { logger } : {}),
    })
  }

  async get(
    key: string,
    group: string,
    load: () => Promise<T>,
    isStillCurrent?: (cached: T) => Promise<boolean>,
  ): Promise<T> {
    // The data source always resolves to the load's result, and load errors
    // propagate (throwIfLoadError defaults on) — so a non-value here is impossible
    // unless T itself includes null.
    return (await this.loader.get({ key, load, isStillCurrent }, group)) as T
  }

  invalidate(key: string, group: string): Promise<void> {
    return this.loader.invalidateCacheFor(key, group)
  }

  invalidateGroup(group: string): Promise<void> {
    return this.loader.invalidateCacheForGroup(group)
  }

  invalidateAll(): Promise<void> {
    return this.loader.invalidateCache()
  }

  /** Releases the notification pair's resources along with the loader. */
  close(): Promise<void> {
    return this.loader.close()
  }
}

/**
 * Build the app-owned cache bag. Called once per process by a facade's
 * composition root and threaded through the dependency bag as the kernel
 * {@link AppCaches} port; `createCore` builds a bare default when a harness
 * passes none.
 */
export function createAppCaches(options: CreateAppCachesOptions = {}): AppCaches {
  const profile: AppCachesProfile = { ...DEFAULT_APP_CACHES_PROFILE, ...options.profile }
  const fragmentCatalog = buildGroupCache<ResolvedCatalogEntry[]>(
    'fragment-catalog',
    profile.fragmentCatalog,
    options,
  )
  const fragmentDocumentBody = buildGroupCache<DocumentContent>(
    'fragment-document-body',
    profile.fragmentDocumentBody,
    options,
  )
  const repoProjection = buildGroupCache<GitHubRepo[]>(
    'repo-projection',
    profile.repoProjection,
    options,
  )
  const repoFiles = buildGroupCache<CachedRepoRead>('repo-files', profile.repoFiles, options)
  const accountModelPolicy = buildGroupCache<AccountModelPolicyCacheValue>(
    'account-model-policy',
    profile.accountModelPolicy,
    options,
  )
  const workspaceSettings = buildGroupCache<WorkspaceSettingsCacheValue>(
    'workspace-settings',
    profile.workspaceSettings,
    options,
  )
  const accountBudgetLimit = buildGroupCache<BudgetLimitCacheValue>(
    'account-budget-limit',
    profile.accountBudgetLimit,
    options,
  )
  const userBudgetLimit = buildGroupCache<BudgetLimitCacheValue>(
    'user-budget-limit',
    profile.userBudgetLimit,
    options,
  )
  return {
    fragmentCatalog,
    fragmentDocumentBody,
    repoProjection,
    repoFiles,
    accountModelPolicy,
    workspaceSettings,
    accountBudgetLimit,
    userBudgetLimit,
    close: async () => {
      await Promise.all([
        fragmentCatalog.close(),
        fragmentDocumentBody.close(),
        repoProjection.close(),
        repoFiles.close(),
        accountModelPolicy.close(),
        workspaceSettings.close(),
        accountBudgetLimit.close(),
        userBudgetLimit.close(),
      ])
    },
  }
}

function buildGroupCache<T>(
  name: string,
  profile: GroupCacheProfile,
  options: CreateAppCachesOptions,
): LayeredGroupCacheHandle<T> {
  const notifications = profile.enabled ? options.notificationPairFactory?.<T>(name) : undefined
  return new LayeredGroupCacheHandle<T>(name, profile, notifications, options.logger)
}
