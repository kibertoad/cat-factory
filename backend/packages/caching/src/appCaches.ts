import type {
  AccountModelPolicyCacheValue,
  AccountSkillRecord,
  AppCaches,
  BudgetLimitCacheValue,
  CachedRepoRead,
  DocumentContent,
  GitHubRepo,
  GroupCacheHandle,
  LinkedDocumentRefreshOutcome,
  LocalModelDeclarationsCacheValue,
  Logger,
  ModelPresetCacheValue,
  Paged,
  ResolvedAccountSettings,
  ResolvedCatalogEntry,
  RiskPolicyCacheValue,
  SessionGenerationCacheValue,
  SsoDiscoveryDocument,
  WorkspaceAccessCacheValue,
  WorkspaceSettingsCacheValue,
  ResolvedFoundationalService,
  OperationalMetrics,
} from '@cat-factory/kernel'
import { noopOperationalMetrics } from '@cat-factory/kernel'
// `layered-loader/core` is the package's Redis-free entrypoint: nothing reachable from it
// imports `ioredis`, which must never load outside the Node facade's REDIS_URL-gated
// notification wiring — the Worker imports this package too. The package root re-exports
// the Redis surface as well, so it is NOT interchangeable with this import; keep it `/core`.
import { GroupLoader } from 'layered-loader/core'
import type {
  AbstractNotificationConsumer,
  BackgroundWorkScheduler,
  GroupNotificationPublisher,
  InMemoryGroupCache,
  Logger as LayeredLoaderLogger,
} from 'layered-loader/core'
import { CACHE_EPOCH_GROUP, GroupGenerationTracker } from './generationCoherency.js'
import type { CacheGenerationStore } from './generationCoherency.js'
import { InvocationScopedLoads } from './invocationScopedLoads.js'

/**
 * layered-loader logs its background failures through a pino-shaped `error(obj, msg?)`.
 * The platform's own convention is message-first (`kernel`'s {@link Logger}), so the
 * adaptation lives HERE — one place, rather than every facade re-deriving it.
 */
function asLayeredLoaderLogger(logger: Logger): LayeredLoaderLogger {
  return {
    error: (objOrMsg: unknown, msg?: string) => {
      if (typeof objOrMsg === 'string') logger.error(objOrMsg)
      else logger.error(msg ?? 'cache error', { detail: objOrMsg })
    },
  }
}

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
  /**
   * Pull-coherency probe cadence, for an enabled cache of our own mutable state on a runtime
   * with no push bus (the Worker): a read whose group snapshot in the injected
   * {@link CacheGenerationStore} is older than this re-reads the directory before serving,
   * applying the group invalidation locally on a moved counter. Bounds cross-isolate staleness
   * at roughly this window. Requires `generationStore`: {@link createAppCaches} REFUSES a
   * profile that sets it on an enabled cache without one, because an enabled TTL'd cache of
   * mutable state with no coherency mechanism is the exact bug the isolate-safe profile
   * exists to prevent.
   */
  coherencyWindowMsecs?: number
  /**
   * Declares that this cache's owning service calls {@link GroupCacheHandle.invalidateAll}.
   *
   * Only meaningful together with `coherencyWindowMsecs`, and it costs something real: a
   * cache-wide invalidation rides the reserved epoch counter, whose shard is ONE globally
   * placed Durable Object, so declaring this puts a cross-colo probe on the cache's read path.
   * A cache with no `invalidateAll` call site leaves it off and probes only its own group.
   *
   * Getting it wrong cannot go quiet: `invalidateAll` on a coherent cache that did NOT declare
   * it THROWS, because dropping the entries locally while peers keep serving them for a full
   * TTL is the failure this flag exists to prevent.
   */
  cacheWideInvalidation?: boolean
}

/** One profile entry per named cache in the kernel {@link AppCaches} bag. */
export interface AppCachesProfile {
  fragmentCatalog: GroupCacheProfile
  skillCatalog: GroupCacheProfile
  foundationalServiceCatalog: GroupCacheProfile
  fragmentDocumentBody: GroupCacheProfile
  linkedDocumentVersion: GroupCacheProfile
  repoProjection: GroupCacheProfile
  repoFiles: GroupCacheProfile
  accountModelPolicy: GroupCacheProfile
  accountSettings: GroupCacheProfile
  workspaceSettings: GroupCacheProfile
  accountBudgetLimit: GroupCacheProfile
  userBudgetLimit: GroupCacheProfile
  viewerRepos: GroupCacheProfile
  patInstallationRepos: GroupCacheProfile
  riskPolicy: GroupCacheProfile
  modelPreset: GroupCacheProfile
  localModelDeclarations: GroupCacheProfile
  workspaceAccess: GroupCacheProfile
  userSessionGeneration: GroupCacheProfile
  ssoDiscovery: GroupCacheProfile
}

/** The default (Node/local/test) profile: caching on, modest bounds. */
export const DEFAULT_APP_CACHES_PROFILE: AppCachesProfile = {
  // One merged catalog per workspace; the key varies only when the workspace's
  // account changes, so a small per-group bound is plenty.
  fragmentCatalog: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 500,
    maxItemsPerGroup: 4,
    // `FragmentLibraryService` drops the whole cache on an ACCOUNT-tier write (it spans every
    // workspace in the account), so this cache needs the epoch counter wherever it runs coherent.
    cacheWideInvalidation: true,
  },
  // One repo-sourced skill catalog per account, keyed by account id (one entry per group).
  // Invalidation-driven (the skill-source sync drops the group after a change); no version
  // probe — a DB read as the probe would cost as much as the DB read as the load.
  skillCatalog: { enabled: true, ttlInMsecs: 5 * 60_000, maxGroups: 2000, maxItemsPerGroup: 1 },
  // One merged foundational-services catalog per workspace, keyed by workspace id. Same
  // invalidation-driven profile as the fragment catalog it mirrors; manifest-only values, so
  // the per-group bound stays small.
  foundationalServiceCatalog: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 500,
    maxItemsPerGroup: 1,
    // Same account-tier blast radius as `fragmentCatalog`, which it mirrors.
    cacheWideInvalidation: true,
  },
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
  // The last-probed source version of a LINKED context document, grouped by workspace and keyed per
  // document. A SHORT 60s TTL and NO refresh window, unlike the body cache above: the load is already
  // the source's cheap version probe, so there is nothing cheaper to re-validate an entry with, and
  // the TTL is the entire coherence story — it bounds how long a run keeps dispatching against a
  // design edit nobody has noticed. A minute collapses a burst of step dispatches (the actual cost
  // being avoided) while a designer's edit reaches the next step of a running pipeline. A task's
  // attached corpus is small, so a modest per-group bound covers every board in the workspace.
  linkedDocumentVersion: {
    enabled: true,
    ttlInMsecs: 60_000,
    maxGroups: 500,
    maxItemsPerGroup: 64,
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
  // One fully-resolved (decrypted) account-settings view per account, keyed by account id
  // (one entry per group). Slow-moving (admin-changed integration credentials);
  // invalidation-driven, no version probe. Replaces the service's legacy 30s homebrew Map —
  // the decrypted secrets stay in-process (only invalidation keys ride the bus).
  accountSettings: {
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
  // One PAT-reachable repo enumeration per user, keyed by user id (one entry per group). Backs
  // the add-service picker's per-keystroke typeahead, so a SHORT TTL (external GitHub state we
  // don't write; a PAT swap invalidates the group explicitly, and a brand-new repo appears once
  // this lapses) — a minute keeps a freshly-created repo from hiding for long while still
  // collapsing a burst of keystrokes into one enumeration.
  viewerRepos: { enabled: true, ttlInMsecs: 60_000, maxGroups: 5000, maxItemsPerGroup: 1 },
  // The local facade's workspace-wide PAT repo enumeration, keyed by installation id (one entry
  // per group). Same freshness reasoning as `viewerRepos` (external GitHub state we don't write;
  // a short TTL collapses a burst of typeahead keystrokes into one multi-page walk while a
  // freshly-created repo can't hide for long). A local deployment has very few installations,
  // so the group bound is small.
  patInstallationRepos: { enabled: true, ttlInMsecs: 60_000, maxGroups: 100, maxItemsPerGroup: 1 },
  // A workspace's resolved merge-threshold presets, keyed per resolved id (`picked:<id>` /
  // `default`) — a workspace has a small preset library, so a modest per-group bound covers the
  // picked presets plus the default. Slow-moving (admin-changed); invalidation-driven, no probe.
  riskPolicy: { enabled: true, ttlInMsecs: 5 * 60_000, maxGroups: 1000, maxItemsPerGroup: 32 },
  // A workspace's resolved MODEL presets, on the same profile as `riskPolicy` one row over: same
  // key shape (`picked:<id>` / `default`), same small library per workspace, same slow-moving
  // admin-changed source. Read harder than the merge preset, though — every dispatch and every
  // inline call resolves both the step's model and the preset's route order through it.
  modelPreset: { enabled: true, ttlInMsecs: 5 * 60_000, maxGroups: 1000, maxItemsPerGroup: 32 },
  // One entry per USER (group == key), holding the runners they enabled a model on. Same profile
  // as the two presets above and for the same reason: hand-edited config that every dispatch
  // re-reads, invalidation-driven, no version probe. One item per group because the whole answer
  // for a user IS one entry, so the per-group bound only has to be non-zero.
  localModelDeclarations: {
    enabled: true,
    ttlInMsecs: 5 * 60_000,
    maxGroups: 5000,
    maxItemsPerGroup: 1,
  },
  // One resolved access decision per (workspace, user) — grouped by workspace, keyed by user, so a
  // large board keeps a member entry each. Slow-moving (roster/access-mode are admin actions);
  // invalidation-driven, no version probe. A SHORT 60s TTL: it's the freshness backstop only (the
  // roster/access-mode/account-membership writes invalidate on commit), and it bounds how long a
  // just-revoked member keeps read access on the rare path an invalidation is missed.
  workspaceAccess: {
    enabled: true,
    ttlInMsecs: 60_000,
    maxGroups: 2000,
    maxItemsPerGroup: 256,
    // An account-membership change alters access to potentially every board, so `AccountService`
    // drops the whole cache rather than enumerating them.
    cacheWideInvalidation: true,
  },
  // One session generation per user, grouped AND keyed by user id (one entry per group), read on
  // every authenticated request. `maxGroups` is therefore sized against CONCURRENTLY ACTIVE users
  // rather than registered ones, and each entry is a single small number. The 60s TTL is the
  // freshness backstop only, exactly as on `workspaceAccess` above: a bump invalidates the key on
  // commit, and the TTL bounds how long a revoked bearer survives on the rare path where an
  // invalidation is missed (a peer replica with no notification bus wired). Every invalidation
  // site is per-user, so it needs no cache-wide epoch probe.
  userSessionGeneration: {
    enabled: true,
    ttlInMsecs: 60_000,
    maxGroups: 5000,
    maxItemsPerGroup: 1,
  },
  // The deployment's discovered SSO provider (metadata + JWKS), grouped AND keyed by issuer
  // URL — so ONE group with one entry, since a deployment configures one provider. An
  // external document we never write: coherence is the TTL plus the key-rotation refetch the
  // reader triggers on an unknown `kid`, not an invalidation. 15 minutes is long enough that a
  // login costs no extra round-trips and short enough that an endpoint move (a provider
  // migrating hosts) heals without a redeploy.
  ssoDiscovery: { enabled: true, ttlInMsecs: 15 * 60_000, maxGroups: 4, maxItemsPerGroup: 4 },
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
 *
 * Every ENABLED entry below is read against ONE FACT that the numbers on the Node profile were
 * not chosen for: the Worker's bag is one per ISOLATE (`appCachesHost.ts`), so an entry lives
 * its whole TTL across requests. It used to be rebuilt per invocation, which quietly capped
 * every one of these at the length of a single wake. The two probe-backed slices therefore
 * widen their refresh window to cover the full TTL here (see each entry); the two that have no
 * probe keep their TTL as the entire bound, which their own numbers were already sized as:
 * `linkedDocumentVersion` at 60s, and `ssoDiscovery` at 15 minutes of EXTERNAL state that
 * additionally self-heals on an unknown `kid`.
 */
export const ISOLATE_SAFE_APP_CACHES_PROFILE: AppCachesProfile = {
  fragmentCatalog: { ...DEFAULT_APP_CACHES_PROFILE.fragmentCatalog, enabled: false },
  // Pass-through for the same reason as `fragmentCatalog`: the skill catalog is our own
  // mutable D1 state with no cross-isolate invalidation bus on the Worker.
  skillCatalog: { ...DEFAULT_APP_CACHES_PROFILE.skillCatalog, enabled: false },
  // Pass-through for the same reason: our own mutable D1 state, no cross-isolate bus.
  foundationalServiceCatalog: {
    ...DEFAULT_APP_CACHES_PROFILE.foundationalServiceCatalog,
    enabled: false,
  },
  fragmentDocumentBody: {
    ...DEFAULT_APP_CACHES_PROFILE.fragmentDocumentBody,
    // The refresh window covers the WHOLE TTL here, unlike the Node profile's last minute of
    // five. The bag is one per ISOLATE, so an entry now lives its full TTL across requests
    // rather than being rebuilt per wake as it was when these numbers were chosen; with a
    // window of one minute, the first four served unprobed. Since the claim that keeps this
    // cache enabled on the Worker at all is "a peer isolate's copy self-heals within the
    // refresh window", the window has to BE the lifetime. The probe is the source's cheap
    // version check, deduped per (group, key) while one is in flight, so a read pays at most
    // one of them and never waits on it.
    ttlLeftBeforeRefreshInMsecs: DEFAULT_APP_CACHES_PROFILE.fragmentDocumentBody.ttlInMsecs,
  },
  // Stays ENABLED here for the same reason, one step further: the entry IS an external source's
  // version token, so it is neither our own mutable state nor in need of a probe to re-validate — a
  // peer isolate's copy self-heals when its 60s TTL lapses. Passing through instead would put a live
  // `probeVersion` in front of every linked document on every step dispatch, which is exactly the
  // per-dispatch cost this cache exists to remove.
  linkedDocumentVersion: { ...DEFAULT_APP_CACHES_PROFILE.linkedDocumentVersion },
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
  repoFiles: {
    ...DEFAULT_APP_CACHES_PROFILE.repoFiles,
    // Same reasoning as `fragmentDocumentBody` above, and this is the slice where it bites
    // hardest: the entries are repo FILE CONTENT, so an unprobed window is a post-op reading
    // pre-commit files that the per-invocation bag made impossible. The `headSha` probe is one
    // cheap call per branch, so covering the whole TTL with it is what makes "bounded by the
    // probe, not indefinite" true now that entries outlive the request that loaded them.
    ttlLeftBeforeRefreshInMsecs: DEFAULT_APP_CACHES_PROFILE.repoFiles.ttlInMsecs,
  },
  // Pass-through for the same reason: the account policy is our own mutable D1 state
  // with no cross-isolate invalidation bus on the Worker.
  accountModelPolicy: { ...DEFAULT_APP_CACHES_PROFILE.accountModelPolicy, enabled: false },
  // Pass-through: the resolved account settings are our own mutable D1 state with no
  // cross-isolate invalidation bus on the Worker, so the isolate resolves them live.
  accountSettings: { ...DEFAULT_APP_CACHES_PROFILE.accountSettings, enabled: false },
  // Pass-through: the workspace-settings row and the budget-limit reads are all our own
  // mutable D1 state with no cross-isolate invalidation bus on the Worker, so the isolate
  // reads them live (no in-memory tier — every read hits D1; only concurrent in-flight
  // loads coalesce) — same class as `repoProjection`/`accountModelPolicy`.
  workspaceSettings: { ...DEFAULT_APP_CACHES_PROFILE.workspaceSettings, enabled: false },
  accountBudgetLimit: { ...DEFAULT_APP_CACHES_PROFILE.accountBudgetLimit, enabled: false },
  userBudgetLimit: { ...DEFAULT_APP_CACHES_PROFILE.userBudgetLimit, enabled: false },
  // Pass-through: neither immutable nor self-verifying (no cheap "did the token's repo set move"
  // probe), and the PAT-swap invalidation can't reach a peer isolate without a bus — so the Worker
  // enumerates the picker live, exactly like the mutable-D1-state slices above.
  viewerRepos: { ...DEFAULT_APP_CACHES_PROFILE.viewerRepos, enabled: false },
  // Pass-through for the same reasons as `viewerRepos` — and the Worker never constructs the
  // local facade's PAT-backed client, so this slice is only ever read on Node/local.
  patInstallationRepos: { ...DEFAULT_APP_CACHES_PROFILE.patInstallationRepos, enabled: false },
  // Pass-through: the merge-preset library is our own mutable D1 state with no cross-isolate
  // invalidation bus on the Worker, so the isolate resolves it live — same class as
  // `workspaceSettings`/`accountModelPolicy`.
  riskPolicy: { ...DEFAULT_APP_CACHES_PROFILE.riskPolicy, enabled: false },
  // Pass-through for exactly the same reason as `riskPolicy`: the model-preset library is our own
  // mutable D1 state, and a TTL'd entry would keep dispatching on a re-pointed model or a
  // re-ordered route list that a peer isolate has already rewritten.
  modelPreset: { ...DEFAULT_APP_CACHES_PROFILE.modelPreset, enabled: false },
  // Pass-through for the same reason again: the endpoint rows are our own mutable D1 state, and a
  // TTL'd entry would keep dispatching on a modality the user has since re-declared, or on a model
  // they un-enabled, in an isolate that never saw the write.
  localModelDeclarations: {
    ...DEFAULT_APP_CACHES_PROFILE.localModelDeclarations,
    enabled: false,
  },
  // Pass-through: the resolved workspace-access decision reads our own mutable D1 state (the roster
  // + access-mode + account memberships) with no cross-isolate invalidation bus on the Worker, so a
  // TTL'd entry would keep granting access after a peer isolate revoked a member. The isolate
  // resolves it live every request — same class as `workspaceSettings`/`accountModelPolicy`.
  workspaceAccess: { ...DEFAULT_APP_CACHES_PROFILE.workspaceAccess, enabled: false },
  // Pass-through, and the reason is `workspaceAccess`'s verbatim: the session generation is our own
  // mutable D1 state with no cross-isolate invalidation bus, so a TTL'd entry would go on admitting
  // a bearer that a peer isolate had already revoked — which on this slice means an offboarded
  // person keeping a working login for up to a minute after the revocation reported success. The
  // isolate resolves it live on every authenticated request instead.
  userSessionGeneration: { ...DEFAULT_APP_CACHES_PROFILE.userSessionGeneration, enabled: false },
  // Stays ENABLED here, unlike every slice above it: the SSO discovery document is EXTERNAL
  // state we never write, and a stale entry self-heals — an ID token signed with a rotated
  // `kid` drops the entry and refetches, so a peer isolate's pre-rotation key set costs one
  // refetch rather than failing logins until eviction. Same "bounded by a probe" reasoning
  // that keeps `fragmentDocumentBody`/`repoFiles` on. Passing through instead would put two
  // IdP round-trips in front of every single sign-in on the facade with the least budget for
  // them.
  ssoDiscovery: { ...DEFAULT_APP_CACHES_PROFILE.ssoDiscovery },
}

/**
 * The isolate-safe profile plus the caches the generation directory makes coherent: selected
 * by the Worker ONLY when its `CACHE_GENERATIONS` Durable Object binding exists (and so a
 * {@link CacheGenerationStore} is injected); with no binding the Worker keeps the pass-through
 * stance above. Flipping a cache here means giving it a real TTL on the Worker with a
 * generation probe bounding its cross-isolate staleness at `coherencyWindowMsecs`; the cache's
 * EVERY invalidation site then also bumps the directory (the handle does both together).
 *
 * `workspaceSettings` is the pilot: exactly one invalidation site
 * (`WorkspaceSettingsService.update`), no `invalidateAll`, and hot on the Worker (read per
 * recorded LLM call, per task-limit guard, per pricing resolution, each a live D1 read
 * today). Further flips are one profile row each, in their own slice
 * (docs/initiatives/caching-layer.md).
 */
export const ISOLATE_COHERENT_APP_CACHES_PROFILE: AppCachesProfile = {
  ...ISOLATE_SAFE_APP_CACHES_PROFILE,
  workspaceSettings: {
    ...DEFAULT_APP_CACHES_PROFILE.workspaceSettings,
    coherencyWindowMsecs: 5_000,
    // The TTL is SHORTER here than the 5 minutes the Node profile carries, and it is sized for
    // a specific job: it is the backstop for a FAILED bump. The probe window bounds staleness
    // at ~5s only while the directory is reachable; when a writer's bump fails the mechanism
    // fails OPEN (the write already committed, so refusing it would be worse) and peers learn
    // nothing until their entry expires, so the TTL, not the window, is the real bound in
    // that case. This row carries `allowInitiatorPat`, `storeAgentContext` and the spend caps,
    // where the failure mode is a revoked permission still being honoured, so the honest
    // number is the one an operator would accept for a REVOCATION, not for a settings edit.
    ttlInMsecs: 60_000,
  },
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
  /** Error sink for background cache/notification failures. */
  logger?: Logger
  /**
   * Where each read's hit/miss is counted. Hit RATE is the only way to tell a cache that is
   * doing its job from one whose invalidation is firing so often it never serves anything —
   * two states with identical latency graphs and opposite fixes. Absent ⇒ uncounted.
   */
  operationalMetrics?: OperationalMetrics
  /**
   * The shared generation directory backing every profile entry with a
   * `coherencyWindowMsecs` (see that field's doc). One directory serves the whole bag, so all
   * coherent caches share each group's probe. Absent ⇒ no entry may set a window.
   */
  generationStore?: CacheGenerationStore
  /**
   * Adopter for the work the loaders start and do not await (preemptive refreshes, staleness
   * probes, notification publishes). On Node the default detached run is correct; an isolate
   * runtime hands the promise to the current request's `ctx.waitUntil` instead, because I/O
   * there is scoped to the request that created it. The promise always settles fulfilled.
   */
  scheduleBackgroundWork?: BackgroundWorkScheduler
  /**
   * Supplied ONLY by an isolate runtime (the Worker): returns an object identifying the
   * invocation currently being served, or `undefined` outside a bracketed entry point.
   *
   * Its presence switches every cache MISS off layered-loader's shared load path and onto the
   * per-invocation one in {@link InvocationScopedLoads}, because the bag is one per ISOLATE
   * and workerd destroys, uncatchably, any invocation that awaits a promise another one
   * created. Absent (Node, where one process serves every request out of one I/O context) ⇒
   * the loader's own coalescing is kept, unchanged.
   */
  currentInvocation?: () => object | undefined
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

/** The optional collaborators one handle may be built with, besides its name and profile. */
interface GroupCacheHandleDeps<T> {
  notifications?: GroupCacheNotifications<T>
  logger?: Logger
  metrics?: OperationalMetrics
  /** Present only for an enabled cache whose profile carries a `coherencyWindowMsecs`. */
  coherency?: { tracker: GroupGenerationTracker; windowMsecs: number }
  scheduleBackgroundWork?: BackgroundWorkScheduler
  /** Present only on an isolate runtime; see {@link CreateAppCachesOptions.currentInvocation}. */
  currentInvocation?: () => object | undefined
}

class LayeredGroupCacheHandle<T> implements GroupCacheHandle<T> {
  private readonly loader: GroupLoader<T, GroupLoadParams<T>>
  /** Set only for an enabled cache whose profile carries a `coherencyWindowMsecs`. */
  private readonly coherency: GroupGenerationTracker | undefined
  private readonly metrics: OperationalMetrics
  /** Set only on an isolate runtime; see {@link CreateAppCachesOptions.currentInvocation}. */
  private readonly invocationLoads: InvocationScopedLoads<T> | undefined
  private readonly enabled: boolean
  /** See {@link GroupCacheProfile.cacheWideInvalidation}. */
  private readonly cacheWideInvalidation: boolean

  constructor(
    private readonly name: string,
    profile: GroupCacheProfile,
    deps: GroupCacheHandleDeps<T>,
  ) {
    const { notifications, logger, coherency, scheduleBackgroundWork } = deps
    this.metrics = deps.metrics ?? noopOperationalMetrics
    this.enabled = profile.enabled
    this.cacheWideInvalidation = profile.cacheWideInvalidation ?? false
    this.invocationLoads = deps.currentInvocation
      ? new InvocationScopedLoads<T>(deps.currentInvocation)
      : undefined
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
      ...(logger ? { logger: asLayeredLoaderLogger(logger) } : {}),
      ...(scheduleBackgroundWork ? { scheduleBackgroundWork } : {}),
    })
    this.coherency = coherency?.tracker
    // The 16.1 apply-remote primitives are handed over BOUND: synchronous, purely local,
    // non-publishing, and fencing (an in-flight load cannot write its pre-invalidation
    // snapshot back), which is exactly what a probe-detected peer change must apply.
    coherency?.tracker.register({
      cacheName: name,
      windowMsecs: coherency.windowMsecs,
      probesEpoch: this.cacheWideInvalidation,
      applyRemoteInvalidationForGroup: (group) => {
        // The invocation-scoped load path publishes outside the loader, so it needs the same
        // news the loader's own fences get: a peer's invalidation must void an in-flight load.
        this.invocationLoads?.noteInvalidation()
        this.loader.applyRemoteInvalidationForGroup(group)
      },
      applyRemoteInvalidation: () => {
        this.invocationLoads?.noteInvalidation()
        this.loader.applyRemoteInvalidation()
      },
    })
  }

  async get(
    key: string,
    group: string,
    load: () => Promise<T>,
    isStillCurrent?: (cached: T) => Promise<boolean>,
  ): Promise<T> {
    // What is measured, precisely: a MISS is a read whose loader ran, a HIT is a read served
    // without it. That is the distinction an operator acts on, and it is observable from here
    // without reaching inside layered-loader. One caveat, stated rather than hidden: a read
    // that lands inside a probe-refresh window can trigger a BACKGROUND reload, and if that
    // reload's load closure runs before this await resolves it is attributed to this read. So
    // the hit rate on a probe-refreshed cache is a floor, never an overstatement.
    // Pull coherency runs BEFORE the loader read: inside the window it resolves with no I/O,
    // past it one shared probe re-reads the generation directory and locally invalidates what
    // moved, so the loader read below never serves an entry a peer already invalidated more
    // than the window ago. Never rejects (probe failure fails closed inside the tracker).
    if (this.coherency) await this.coherency.ensureFresh(this.name, group)
    if (this.invocationLoads) {
      return this.getWithoutCrossInvocationJoin(
        this.invocationLoads,
        key,
        group,
        load,
        isStillCurrent,
      )
    }
    let loaderRan = false
    const countedLoad = () => {
      loaderRan = true
      return load()
    }
    // The data source always resolves to the load's result, and load errors
    // propagate (throwIfLoadError defaults on) — so a non-value here is impossible
    // unless T itself includes null.
    const value = (await this.loader.get({ key, load: countedLoad, isStillCurrent }, group)) as T
    this.metrics.increment(loaderRan ? 'cache.miss' : 'cache.hit', { cache: this.name })
    return value
  }

  /**
   * The isolate-runtime read: the same two tiers as the loader's own `get`, but split so the
   * MISS half never enters layered-loader's shared load path, whose in-flight map is the one
   * piece of the isolate-scoped bag that would hand this invocation a promise created by
   * another (see {@link InvocationScopedLoads}).
   *
   * The HIT half still goes through the loader, so an entry entering its refresh window keeps
   * scheduling the preemptive reload / staleness probe exactly as before: that read only
   * INSPECTS the in-flight map, it never awaits what it finds there.
   */
  private async getWithoutCrossInvocationJoin(
    invocationLoads: InvocationScopedLoads<T>,
    key: string,
    group: string,
    load: () => Promise<T>,
    isStillCurrent?: (cached: T) => Promise<boolean>,
  ): Promise<T> {
    const params: GroupLoadParams<T> = { key, load, ...(isStillCurrent ? { isStillCurrent } : {}) }
    // `undefined` is the miss; `null` is a legitimately cached resolved-but-empty value.
    const cached = this.loader.getInMemoryOnly(params, group)
    if (cached !== undefined) {
      this.metrics.increment('cache.hit', { cache: this.name })
      return cached as T
    }
    // NUL-separated, so no group/key pair can ever spell another pair's composite.
    const composite = `${group}\u0000${key}`
    const { value, loaded } = await invocationLoads.run(composite, load, (fresh) =>
      // A pass-through cache has no in-memory tier to publish into: every read loads, which is
      // what `enabled: false` means. Publishing would be a no-op through the loader's noop
      // cache, but saying so here keeps the pass-through stance readable.
      this.enabled ? this.loader.forceSetValueForGroup(key, fresh, group) : Promise.resolve(),
    )
    this.metrics.increment(loaded ? 'cache.miss' : 'cache.hit', { cache: this.name })
    return value
  }

  // Each invalidation bumps the generation directory AFTER the local invalidation resolves,
  // and the write path awaits both, so "invalidate right after the write commits" spans the
  // peers' view too. A single-key invalidation bumps its whole GROUP's counter: coarser than
  // the local drop (peers re-load the group once), but the directory then never needs per-key
  // state, and every coherent cache today keys group == key anyway. A bump failure fails open
  // inside the tracker (peers heal at the TTL), so none of these can turn a committed write
  // into a thrown request.

  async invalidate(key: string, group: string): Promise<void> {
    this.invocationLoads?.noteInvalidation()
    await this.loader.invalidateCacheFor(key, group)
    await this.coherency?.noteLocalInvalidation(this.name, group)
  }

  async invalidateGroup(group: string): Promise<void> {
    this.invocationLoads?.noteInvalidation()
    await this.loader.invalidateCacheForGroup(group)
    await this.coherency?.noteLocalInvalidation(this.name, group)
  }

  async invalidateAll(): Promise<void> {
    if (this.coherency && !this.cacheWideInvalidation) {
      // Refused rather than half-applied: without the declaration peers never probe the epoch
      // counter, so this call would drop the entries on THIS instance while every other one
      // kept serving them until their TTL, a coherency hole that looks like a working
      // invalidation from the caller's side.
      throw new Error(
        `cache '${this.name}' called invalidateAll() but its profile does not set ` +
          `cacheWideInvalidation, so peer instances never probe the epoch counter this would ` +
          `bump. Set it on the profile entry (it turns the epoch probe on for this cache).`,
      )
    }
    this.invocationLoads?.noteInvalidation()
    await this.loader.invalidateCache()
    await this.coherency?.noteLocalInvalidation(this.name, CACHE_EPOCH_GROUP)
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
  assertCoherencyWirable(profile, options)
  // One tracker serves the whole bag, so every coherent cache shares each group's probe.
  const tracker = options.generationStore
    ? new GroupGenerationTracker(options.generationStore, {
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.operationalMetrics ? { metrics: options.operationalMetrics } : {}),
        // The probe is a Durable Object round trip, so its in-flight promise is subject to the
        // same cross-invocation rule as a load: coalesce within one invocation, never across.
        ...(options.currentInvocation ? { currentInvocation: options.currentInvocation } : {}),
      })
    : undefined
  const fragmentCatalog = buildGroupCache<ResolvedCatalogEntry[]>(
    'fragment-catalog',
    profile.fragmentCatalog,
    options,
    tracker,
  )
  const skillCatalog = buildGroupCache<AccountSkillRecord[]>(
    'skill-catalog',
    profile.skillCatalog,
    options,
    tracker,
  )
  const foundationalServiceCatalog = buildGroupCache<ResolvedFoundationalService[]>(
    'foundational-service-catalog',
    profile.foundationalServiceCatalog,
    options,
    tracker,
  )
  const fragmentDocumentBody = buildGroupCache<DocumentContent>(
    'fragment-document-body',
    profile.fragmentDocumentBody,
    options,
    tracker,
  )
  const linkedDocumentVersion = buildGroupCache<LinkedDocumentRefreshOutcome>(
    'linked-document-version',
    profile.linkedDocumentVersion,
    options,
    tracker,
  )
  const repoProjection = buildGroupCache<GitHubRepo[]>(
    'repo-projection',
    profile.repoProjection,
    options,
    tracker,
  )
  const repoFiles = buildGroupCache<CachedRepoRead>(
    'repo-files',
    profile.repoFiles,
    options,
    tracker,
  )
  const accountModelPolicy = buildGroupCache<AccountModelPolicyCacheValue>(
    'account-model-policy',
    profile.accountModelPolicy,
    options,
    tracker,
  )
  const accountSettings = buildGroupCache<ResolvedAccountSettings>(
    'account-settings',
    profile.accountSettings,
    options,
    tracker,
  )
  const workspaceSettings = buildGroupCache<WorkspaceSettingsCacheValue>(
    'workspace-settings',
    profile.workspaceSettings,
    options,
    tracker,
  )
  const accountBudgetLimit = buildGroupCache<BudgetLimitCacheValue>(
    'account-budget-limit',
    profile.accountBudgetLimit,
    options,
    tracker,
  )
  const userBudgetLimit = buildGroupCache<BudgetLimitCacheValue>(
    'user-budget-limit',
    profile.userBudgetLimit,
    options,
    tracker,
  )
  const viewerRepos = buildGroupCache<Paged<GitHubRepo>>(
    'viewer-repos',
    profile.viewerRepos,
    options,
    tracker,
  )
  const patInstallationRepos = buildGroupCache<Paged<GitHubRepo>>(
    'pat-installation-repos',
    profile.patInstallationRepos,
    options,
    tracker,
  )
  const riskPolicy = buildGroupCache<RiskPolicyCacheValue>(
    'risk-policy',
    profile.riskPolicy,
    options,
    tracker,
  )
  const modelPreset = buildGroupCache<ModelPresetCacheValue>(
    'model-preset',
    profile.modelPreset,
    options,
    tracker,
  )
  const localModelDeclarations = buildGroupCache<LocalModelDeclarationsCacheValue>(
    'local-model-declarations',
    profile.localModelDeclarations,
    options,
    tracker,
  )
  const workspaceAccess = buildGroupCache<WorkspaceAccessCacheValue>(
    'workspace-access',
    profile.workspaceAccess,
    options,
    tracker,
  )
  const userSessionGeneration = buildGroupCache<SessionGenerationCacheValue>(
    'user-session-generation',
    profile.userSessionGeneration,
    options,
    tracker,
  )
  const ssoDiscovery = buildGroupCache<SsoDiscoveryDocument>(
    'sso-discovery',
    profile.ssoDiscovery,
    options,
    tracker,
  )
  return {
    fragmentCatalog,
    skillCatalog,
    foundationalServiceCatalog,
    fragmentDocumentBody,
    linkedDocumentVersion,
    repoProjection,
    repoFiles,
    accountModelPolicy,
    accountSettings,
    workspaceSettings,
    accountBudgetLimit,
    userBudgetLimit,
    viewerRepos,
    patInstallationRepos,
    riskPolicy,
    modelPreset,
    localModelDeclarations,
    workspaceAccess,
    userSessionGeneration,
    ssoDiscovery,
    close: async () => {
      await Promise.all([
        fragmentCatalog.close(),
        skillCatalog.close(),
        foundationalServiceCatalog.close(),
        fragmentDocumentBody.close(),
        linkedDocumentVersion.close(),
        repoProjection.close(),
        repoFiles.close(),
        accountModelPolicy.close(),
        accountSettings.close(),
        workspaceSettings.close(),
        accountBudgetLimit.close(),
        userBudgetLimit.close(),
        viewerRepos.close(),
        patInstallationRepos.close(),
        riskPolicy.close(),
        modelPreset.close(),
        localModelDeclarations.close(),
        workspaceAccess.close(),
        userSessionGeneration.close(),
        ssoDiscovery.close(),
      ])
    },
  }
}

/**
 * An enabled cache with a coherency window but no directory to probe would be a TTL'd cache
 * of mutable state with no invalidation reaching it, the exact bug the isolate-safe profile
 * exists to prevent, so the combination is refused at construction, not degraded.
 */
function assertCoherencyWirable(profile: AppCachesProfile, options: CreateAppCachesOptions): void {
  if (options.generationStore) return
  for (const [name, entry] of Object.entries(profile)) {
    if (entry.enabled && entry.coherencyWindowMsecs !== undefined) {
      throw new Error(
        `cache '${name}' sets coherencyWindowMsecs but createAppCaches got no generationStore; ` +
          `wire one or drop the window (an enabled TTL'd cache of mutable state with no ` +
          `coherency mechanism would serve stale data after a peer's write)`,
      )
    }
  }
}

function buildGroupCache<T>(
  name: string,
  profile: GroupCacheProfile,
  options: CreateAppCachesOptions,
  tracker: GroupGenerationTracker | undefined,
): LayeredGroupCacheHandle<T> {
  const notifications = profile.enabled ? options.notificationPairFactory?.<T>(name) : undefined
  const coherency =
    tracker && profile.enabled && profile.coherencyWindowMsecs !== undefined
      ? { tracker, windowMsecs: profile.coherencyWindowMsecs }
      : undefined
  return new LayeredGroupCacheHandle<T>(name, profile, {
    ...(notifications ? { notifications } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.operationalMetrics ? { metrics: options.operationalMetrics } : {}),
    ...(coherency ? { coherency } : {}),
    ...(options.scheduleBackgroundWork
      ? { scheduleBackgroundWork: options.scheduleBackgroundWork }
      : {}),
    ...(options.currentInvocation ? { currentInvocation: options.currentInvocation } : {}),
  })
}
