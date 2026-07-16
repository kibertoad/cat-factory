import type {
  GitHubRepo,
  ModelFamilyPolicy,
  RiskPolicy,
  WorkspaceSettings,
} from '../domain/types.js'
import type { ResolvedAccountSettings } from './account-settings-repositories.js'
import type { DocumentContent } from './document-source.js'
import type { ResolvedCatalogEntry } from './fragment-repositories.js'
import type { RepoContentEntry, RepoFileContent } from './github-client.js'
import type { WorkspaceSettingsRepository } from './workspace-settings-repositories.js'

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
 * One cached `RepoFiles` read (slice 4). A getFile / listDirectory result plus the
 * branch head sha it reflects, so the staleness probe can re-validate a git-backed
 * entry with a single cheap `headSha` compare instead of a per-file contents-API
 * refetch. `headSha` is null for a sha-pinned or tag ref (immutable — those entries
 * never probe stale). Discriminated by `kind` because getFile and listDirectory share
 * one branch-scoped cache (distinct key prefixes within the same group).
 */
export type CachedRepoRead =
  | {
      readonly kind: 'file'
      readonly headSha: string | null
      readonly content: RepoFileContent | null
    }
  | { readonly kind: 'dir'; readonly headSha: string | null; readonly entries: RepoContentEntry[] }

/**
 * The group a cached {@link CachedRepoRead} lives under: one branch of one repo of one
 * installation. `commitFiles` self-invalidates the branch it wrote, and the push webhook
 * invalidates the branch it saw move, both via this exact key — so the server wrapper (which
 * reads through the cache) and the integrations webhook (which invalidates it) MUST build the
 * group identically. Kept here in kernel, the shared layer both import, to keep the two in step.
 *
 * `owner`/`repo` are lower-cased because GitHub treats them case-insensitively but the read path
 * (projected repo row) and the invalidation path (raw push payload) derive them from different
 * sources whose casing isn't guaranteed identical — normalising here means a casing difference
 * can't silently target a different group and no-op the invalidation. `ref` is left as-is: git
 * refs ARE case-sensitive.
 */
export function repoFilesCacheGroup(
  installationId: number,
  owner: string,
  repo: string,
  ref: string,
): string {
  return `${installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`
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
   * Checkout-free {@link RepoFiles} reads (`getFile`/`listDirectory`) an agent's
   * repo-op runs against a run's branch for idempotency byte-compares — grouped by
   * `(installationId, owner, repo, branch)` via {@link repoFilesCacheGroup} and keyed
   * per path (`f:`/`d:` prefixes). A self-verifying cache: an entry entering its refresh
   * window runs the branch's cheap `headSha` probe and keeps its cached content when the
   * branch hasn't moved, so the blueprint/spec post-ops don't re-fetch the same files on a
   * re-run/replay. The owning `commitFiles` self-invalidates the branch group after it
   * commits, and the push webhook invalidates a branch it saw move; a sha-pinned read is
   * immutable (no probe). Stays enabled on the Worker's isolate-safe profile — like the
   * document-body cache, the head-sha probe re-validates without a cross-isolate bus.
   */
  repoFiles: GroupCacheHandle<CachedRepoRead>
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
  /**
   * An account's fully-resolved (decrypted) deployment settings
   * (`AccountSettingsService.resolve` — the Slack/Linear OAuth secrets, web-search keys,
   * content-storage config + S3 credentials), grouped AND keyed by account id. Read on the
   * runtime integration paths (the Slack/Linear OAuth resolvers, the web-search proxy, the
   * per-account S3 blob backend) — slow-moving, admin-changed. This is the slice that
   * replaces the service's legacy 30s homebrew TTL `Map` (the anti-pattern CLAUDE.md names):
   * coherence is invalidation-driven — the sole write path (`AccountSettingsService.write`,
   * behind the account-settings update controller) drops the account's entry after the write
   * commits, so a credential change is visible on the very next read on any replica. The
   * DECRYPTED secrets stay in-process: the notification bus only ever broadcasts invalidation
   * KEYS (never values), so plaintext secrets never cross the wire — same safety as the old
   * Map, plus cross-replica coherence. Pass-through on the Worker's isolate-safe profile (our
   * own mutable D1 state, no cross-isolate bus), so it caches only on the Node/local facades.
   */
  accountSettings: GroupCacheHandle<ResolvedAccountSettings>
  /**
   * A workspace's persisted runtime settings row (`workspaceSettingsRepository.get`),
   * grouped AND keyed by workspace id — the slow-moving, admin-changed row read on
   * several hot paths: `LlmObservabilityService.bodiesEnabled` (per recorded LLM call),
   * the per-service task-limit start guard, `WorkspaceSettingsService.get`, and
   * `SpendService.resolvePricing` (which overlays this row's budget overrides onto the
   * base pricing table — folding in the old per-service pricing `Map`). Wrapped
   * ({@link WorkspaceSettingsCacheValue}) so the common "no row persisted yet" case caches
   * as a value rather than a re-loaded null. Coherence is invalidation-driven: the sole
   * write path (`WorkspaceSettingsService.update`) drops the workspace's entry after the
   * write commits, so a budget/settings edit is visible on the very next read. Pass-through
   * on the Worker's isolate-safe profile (our own mutable D1 state, no cross-isolate bus),
   * so it caches only on the Node/local facades.
   */
  workspaceSettings: GroupCacheHandle<WorkspaceSettingsCacheValue>
  /**
   * The ACCOUNT budget tier's configured monthly limit (`accountRepository.get(id)
   * .spendMonthlyLimit`), grouped AND keyed by account id — read per proxied LLM call and
   * per advance tick by `SpendService.isOverBudget`/`accountStatus`. Wrapped
   * ({@link BudgetLimitCacheValue}) so an unset limit caches as a value. Invalidation-driven:
   * an account-budget edit invalidates the entry via `SpendService.invalidateAccountLimit`
   * (wired from `AccountService`'s budget-change callback). Pass-through on the Worker's
   * isolate-safe profile (our own mutable D1 state).
   */
  accountBudgetLimit: GroupCacheHandle<BudgetLimitCacheValue>
  /**
   * The USER budget tier's configured monthly limit (`userSettingsRepository.get(id)
   * .spendMonthlyLimit`), grouped AND keyed by user id — the user analogue of
   * {@link AppCaches.accountBudgetLimit}. Invalidated via `SpendService.invalidateUserLimit`
   * (wired from `UserSettingsService`'s budget-change callback). Pass-through on the Worker's
   * isolate-safe profile.
   */
  userBudgetLimit: GroupCacheHandle<BudgetLimitCacheValue>
  /**
   * The signed-in viewer's PAT-reachable repo enumeration (`GET /user/repos`), grouped AND
   * keyed by user id — the add-service picker's typeahead re-runs it on every keystroke, and a
   * broad PAT (hundreds–thousands of repos) makes each run a multi-page walk. The picker filters
   * this cached complete set in memory, so a keystroke costs a substring scan rather than a fresh
   * enumeration. Unlike the invalidation-driven slices above the cached SOURCE is external GitHub
   * state we never write, so coherence is the short TTL: the only local mutation that changes what
   * the key resolves to — the user swapping their stored PAT — invalidates the group explicitly
   * (`UserSecretService` on a `github_pat` write/removal); a repo created straight on GitHub simply
   * appears once the TTL lapses. Pass-through on the Worker's isolate-safe profile: it is neither
   * immutable nor self-verifying, and a PAT-swap invalidation can't reach a peer isolate without a
   * bus, so the Worker enumerates live (caching only on the Node/local facades, where the PAT
   * picker is the primary flow).
   */
  viewerRepos: GroupCacheHandle<GitHubRepo[]>
  /**
   * The local facade's workspace-wide PAT repo enumeration (`GET /user/repos` with the
   * deployment's `GITHUB_PAT`), grouped AND keyed by installation id — the workspace-credential
   * analogue of {@link AppCaches.viewerRepos}. Local mode's PAT-backed client serves the
   * add-service picker's realtime search by enumerating the PAT's whole reachable set and
   * filtering in memory (a PAT can't scope GitHub's global repo search), so without this slice
   * every keystroke re-pays the full multi-page walk. The typeahead filters this cached complete
   * set instead; the blank browse-all stays live/uncached (it wants fresh data). Like
   * `viewerRepos` the cached SOURCE is external GitHub state we never write, so coherence is the
   * short TTL — and the local PAT is fixed per boot (env-supplied), so there is no swap-write to
   * invalidate on; a repo created straight on GitHub appears once the TTL lapses. Pass-through on
   * the Worker's isolate-safe profile for the same reasons as `viewerRepos` (the Worker never
   * builds a PAT-backed client anyway).
   */
  patInstallationRepos: GroupCacheHandle<GitHubRepo[]>
  /**
   * A task's resolved merge-threshold preset (`riskPolicyRepository.get(id)` for a task's
   * picked preset, else `getDefault`), grouped by workspace id and keyed by the resolved id
   * (`picked:<id>` / `default`) — the slow-moving, admin-changed row `resolveRiskPolicy` re-reads
   * on every gate evaluation (per review/tester/human-test/visual gate action and per merge
   * resolve). Wrapped ({@link RiskPolicyCacheValue}) so a picked-preset miss (deleted id falling
   * through to the default) or an unseeded workspace's null default caches as a value rather than
   * a re-loaded null. Coherence is invalidation-driven: every `RiskPolicyService` write
   * (create/update/remove/reseed + the lazy first-use seed) drops the workspace group after the
   * write commits, so a preset edit is visible on the very next gate. Pass-through on the Worker's
   * isolate-safe profile (our own mutable D1 state, no cross-isolate bus), so it caches only on the
   * Node/local facades.
   */
  riskPolicy: GroupCacheHandle<RiskPolicyCacheValue>
  /** Release notification-bus resources (a no-op for bare in-memory caches). */
  close(): Promise<void>
}

/** Cache-friendly wrapper for the account policy read (`null` ⇒ no policy / `off`). */
export interface AccountModelPolicyCacheValue {
  policy: ModelFamilyPolicy | null
}

/** Cache-friendly wrapper for the workspace settings read (`null` ⇒ no row persisted yet). */
export interface WorkspaceSettingsCacheValue {
  settings: WorkspaceSettings | null
}

/** Cache-friendly wrapper for a budget tier's configured limit (`null` ⇒ no limit set). */
export interface BudgetLimitCacheValue {
  limit: number | null
}

/**
 * Cache-friendly wrapper for a merge-threshold preset read (`null` ⇒ the preset id doesn't
 * resolve — a deleted picked id or an unseeded workspace's absent default — so the caller falls
 * through, exactly as an uncached read would).
 */
export interface RiskPolicyCacheValue {
  policy: RiskPolicy | null
}

/**
 * Read a workspace's settings row through the {@link AppCaches.workspaceSettings} slice
 * (or straight from the repository when no cache is wired — tests/standalone services).
 * Shared by every reader of the slice (`WorkspaceSettingsService`, `SpendService`,
 * `LlmObservabilityService`) so they build the cache key/group identically and can never
 * drift — the same reasoning as {@link repoFilesCacheGroup}. Group == key == workspace id.
 *
 * The returned object is the SHARED cached instance (on a Node/local cache hit every caller
 * gets the same reference), so callers MUST treat it as immutable — never mutate a field of
 * the result. Derive a new object instead (as `SpendService.resolvePricing` and
 * `WorkspaceSettingsService.update` do); mutating it in place would corrupt the entry for
 * every other reader and, via the notification bus, every replica's logical view of it.
 */
export async function readCachedWorkspaceSettings(
  cache: GroupCacheHandle<WorkspaceSettingsCacheValue> | undefined,
  repository: WorkspaceSettingsRepository,
  workspaceId: string,
): Promise<WorkspaceSettings | null> {
  if (!cache) return repository.get(workspaceId)
  const { settings } = await cache.get(workspaceId, workspaceId, async () => ({
    settings: await repository.get(workspaceId),
  }))
  return settings
}
