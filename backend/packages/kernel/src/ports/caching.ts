import type {
  GitHubRepo,
  ModelFamilyPolicy,
  ModelPreset,
  RiskPolicy,
  WorkspaceSettings,
} from '../domain/types.js'
import type { ResolvedAccountSettings } from './account-settings-repositories.js'
import type { LocalModelDeclarations } from '../domain/local-model-declarations.js'
import type { LocalModelEndpointRepository } from './local-model-repositories.js'
import type { DocumentContent, LinkedDocumentRefreshOutcome } from './document-source.js'
import type { ResolvedCatalogEntry } from './fragment-repositories.js'
import type { AccountSkillRecord } from './skill-repositories.js'
// Re-exported so `@cat-factory/caching` can name this handle's value type without taking a
// direct dependency on the contracts package (the same reason `agent-context.ts` re-exports
// its wire shapes).
import type { ResolvedFoundationalService } from '@cat-factory/contracts'
export type { ResolvedFoundationalService }
import type { SsoDiscoveryDocument } from './sso.js'
import type { Paged, RepoContentEntry, RepoFileContent } from './github-client.js'
import type { WorkspaceSettingsRepository } from './workspace-settings-repositories.js'
import type { WorkspaceAccess } from '../domain/workspace-access.js'

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
   * An account's repo-sourced Claude Skills catalog (`account_skills`), grouped AND
   * keyed by account id (one entry per group). Read on every agent dispatch that
   * resolves a skill step (slice 2) and by the account management surface; the
   * skill-source sync invalidates the group after a change. Our own mutable D1/Postgres
   * state, so — like `fragmentCatalog`/`repoProjection` — it passes through on the Worker.
   */
  skillCatalog: GroupCacheHandle<AccountSkillRecord[]>
  /**
   * The merged (builtin ⊕ account ⊕ workspace) FOUNDATIONAL SERVICES catalog, grouped AND keyed by
   * workspace id. Read on every design dispatch (the Architect's prompt folds it) and by the
   * lazy contract read that follows, so it is the same read-per-dispatch profile the fragment
   * catalog has. Manifest only — the cached value carries operation names and byte sizes, never
   * a contract document body, so a workspace with a 200 KB OpenAPI spec does not put 200 KB in
   * every replica's memory. Every write path (register/update/delete, a source sync/unlink)
   * invalidates the affected groups; our own mutable D1/Postgres state, so — like
   * `fragmentCatalog`/`skillCatalog` — it passes through on the Worker.
   */
  foundationalServiceCatalog: GroupCacheHandle<ResolvedFoundationalService[]>
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
   * The OUTCOME of the last attempt to bring a linked context document up to date, grouped by
   * workspace and keyed by `<source>:<externalId>`: what the dispatch-time refresh
   * ({@link LinkedDocumentRefresher}) concluded when it last asked the source about this page.
   *
   * The sibling of `fragmentDocumentBody`, and deliberately NOT the same entry: this one caches a
   * VERDICT, not the body. Linked context is re-resolved on every STEP dispatch, so what has to be
   * collapsed is the repeated round trip to the source: a whole-file Figma import fans out into
   * chunked per-frame node reads, and caching the body would put that download on the critical path
   * of any dispatch that missed. Caching the small verdict instead means an unchanged design costs
   * one `?depth=1` read per TTL window and a changed one pays the download exactly once.
   *
   * The entry covers the WHOLE ladder rather than the probe alone, which is what makes that claim
   * true of the expensive half too: the re-import runs inside the loader, so concurrent dispatches
   * of the same document dedupe onto one download, and an `unreachable` outcome (a 403, a rate
   * limit, an outage) is a cached VALUE rather than a thrown loader, without which a source that
   * is down re-runs the entire fan-out on every dispatch for as long as it stays down.
   *
   * Hence no refresh window: the load IS the check, so there is nothing cheaper to re-validate it
   * with. A short TTL plus invalidation on every write that can move either side of the comparison
   * (a connection connect/disconnect drops the workspace GROUP; a manual re-import drops the
   * document's own entry) is the coherence story, and the TTL bounds how long a run can keep
   * dispatching against a design edit it has not noticed.
   */
  linkedDocumentVersion: GroupCacheHandle<LinkedDocumentRefreshOutcome>
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
  viewerRepos: GroupCacheHandle<Paged<GitHubRepo>>
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
  patInstallationRepos: GroupCacheHandle<Paged<GitHubRepo>>
  /**
   * A task's resolved merge-threshold preset (`riskPolicyRepository.get(id)` for a task's
   * picked preset, else `getDefault`), grouped by workspace id and keyed by the resolved id
   * (`picked:<id>` / `default`) — the slow-moving, admin-changed row `resolveRiskPolicy` re-reads
   * on every gate evaluation (per review/tester/human-test/visual gate action and per merge
   * resolve). Wrapped ({@link RiskPolicyCacheValue}) so a picked-preset miss (deleted id falling
   * through to the default) or an unseeded workspace's null default caches as a value rather than
   * a re-loaded null.
   *
   * Coherence is invalidation-driven, and since ADR 0055 there are TWO tiers of write with two
   * different blast radii:
   *
   * - **A board's own write** (`RiskPolicyService` create/update/remove/reseed/clone, the two
   *   suppression writes, and the lazy first-use seed) drops that WORKSPACE GROUP after the write
   *   commits, so a preset edit — or an inherited policy being hidden — is visible on the very next
   *   gate.
   * - **An ACCOUNT-tier write** (`AccountRiskPolicyService` create/update/remove) drops the WHOLE
   *   slice, because one account policy is inherited by every board under it and enumerating those
   *   boards would be a read per invalidation. Over-invalidation is always safe; reading this slice
   *   as workspace-grouped-only is not, since an account write dropping one group would leave every
   *   other board in the account resolving the old posture until the TTL lapsed.
   *
   * Pass-through on the Worker's isolate-safe profile (our own mutable D1 state, no cross-isolate
   * bus), so it caches only on the Node/local facades.
   *
   * The merged LIBRARY LIST is deliberately not cached here. Its readers are the board snapshot and
   * the two selection guards, and a guard is an admission decision, which is the last place to want
   * a stale-by-a-TTL answer (see `riskPolicyResolution.ts`); the list is instead kept to the round
   * trips it took before the account tier existed.
   */
  riskPolicy: GroupCacheHandle<RiskPolicyCacheValue>
  /**
   * A block's resolved MODEL preset (`modelPresetRepository.get(id)` for a task's selected preset,
   * else `getDefault`), grouped by workspace id and keyed by the resolved id (`picked:<id>` /
   * `default`) — the exact shape of {@link AppCaches.riskPolicy} one row over, and for the same
   * reason: the row is slow-moving admin config that the run path re-reads constantly. Every
   * dispatch reads it for the step's model AND the preset's route order, every INLINE call reads
   * it again, and the start guard reads it once per capability resolution (twice per start, since
   * the usable-model gate and the budget gate each resolve their own).
   *
   * Wrapped ({@link ModelPresetCacheValue}) so a selected-preset miss (a deleted id falling through
   * to the default) or an unseeded workspace's null default caches as a value rather than a
   * re-loaded null. Coherence is invalidation-driven: every `ModelPresetService` write
   * (create/update/remove/reseed + the lazy first-use seed) drops the workspace group after the
   * write commits, so a preset edit — a re-pointed model or a re-ordered route list — is visible on
   * the very next dispatch. Pass-through on the Worker's isolate-safe profile (our own mutable D1
   * state, no cross-isolate bus), so it caches only on the Node/local facades.
   */
  modelPreset: GroupCacheHandle<ModelPresetCacheValue>
  /**
   * What the resolving USER declared about the locally-run models they enabled, grouped AND keyed
   * by user id (one entry per group) and projected to what a reader needs
   * ({@link LocalModelDeclarationsCacheValue}), so no sealed bearer key ever enters the bag.
   *
   * Its profile is `modelPreset`'s and its reason is the same: a per-dispatch read of a slow-moving
   * row that a person edits by hand, from a settings panel, a handful of times ever. EVERY dispatch
   * resolves it (the winning model is not known until `resolveStepModelRef` has walked its sources,
   * so the read cannot be deferred to a local pin), which is a query per step on every deployment
   * including the vast majority that have wired no runner at all, and one extra
   * `/internal/persistence` round trip per step in mothership mode.
   *
   * Coherence is invalidation-driven: the two write paths (the endpoint upsert and remove, both
   * behind one per-user controller) drop the user's entry after the write commits, so enabling a
   * model or re-declaring its modality is visible on the very next dispatch. Pass-through on the
   * Worker's isolate-safe profile (our own mutable D1 state, no cross-isolate bus), so it caches
   * only on the Node/local facades.
   */
  localModelDeclarations: GroupCacheHandle<LocalModelDeclarationsCacheValue>
  /**
   * The signed-in caller's resolved workspace-RBAC access to one board (workspace-rbac
   * initiative), grouped by workspace id and keyed by user id — the three-read resolution
   * (`accessRowOf` + account roles + the member row) the shared auth gate runs on EVERY
   * `/workspaces/:ws/*` request. Wrapped ({@link WorkspaceAccessCacheValue}) so BOTH a denial
   * (`{allowed:false}`) and a missing board (`null`) cache as values — negative caching, since
   * layered-loader treats a bare `null` as unresolved. Group == workspace id / key == user id, so
   * one workspace-scoped event drops every member's entry; a workspace never changes accounts, so
   * the (accessRow, accountRoles, memberRole) triple a load resolves is stable under this key.
   * Coherence is invalidation-driven, after the write commits: workspace-member roster writes,
   * an access-mode flip, and a workspace delete drop the workspace GROUP; the rarer account-tier
   * membership writes (add member / set roles / invitation accept) drop EVERYTHING
   * (`invalidateAll` — over-invalidation is safe and enumerating an account's boards just to
   * invalidate isn't worth a port method). Pass-through on the Worker's isolate-safe profile (our
   * own mutable D1 state, no cross-isolate bus), so it caches only on the Node/local facades.
   */
  workspaceAccess: GroupCacheHandle<WorkspaceAccessCacheValue>
  /**
   * A user's SESSION GENERATION, grouped AND keyed by user id (one entry per group), read on
   * EVERY authenticated request so a revoked bearer stops being accepted.
   *
   * This entry exists because the check it serves is a NEW read, not a fold into an existing one.
   * Session verification was pure HMAC arithmetic and touched no store at all: `requireAuth`
   * publishes the user straight off the token claims, and the workspace gate reads MEMBERSHIP
   * rows, never the user row. So making a stateless token revocable costs a per-request lookup,
   * and this is where that cost is paid down.
   *
   * Wrapped ({@link SessionGenerationCacheValue}) so an ABSENT user (`null`) caches as a value
   * rather than reading as unresolved — that is the negative case that matters, since a deleted
   * user's still-unexpired bearer would otherwise re-query the store on every request it makes.
   *
   * Coherence is invalidation-driven, exactly like `workspaceAccess`: every generation bump drops
   * the key right after the write commits, and the TTL is only the backstop for a bump that
   * happened somewhere without a bus. Pass-through on the Worker's isolate-safe profile, and the
   * reason transfers verbatim: our own mutable state with no cross-isolate invalidation bus, so a
   * TTL'd entry would go on admitting a bearer a peer isolate had already revoked. The Worker
   * therefore resolves it live, as it already does for workspace access.
   */
  userSessionGeneration: GroupCacheHandle<SessionGenerationCacheValue>
  /**
   * The deployment's discovered enterprise SSO provider — its
   * `/.well-known/openid-configuration` metadata plus the JWKS its ID tokens verify against,
   * grouped AND keyed by the configured issuer URL. Read twice per SSO sign-in (once to build
   * the authorize redirect, once to verify the returned ID token), so without this every login
   * pays two extra round-trips to the IdP before the user's own request can proceed.
   *
   * Unlike the invalidation-driven slices above, the cached SOURCE is an external document we
   * never write, and it SELF-HEALS rather than needing a bus: an ID token signed with a `kid`
   * absent from the cached JWKS drops the entry and refetches once (rate-limited by
   * `fetchedAt`), because providers rotate signing keys with no notice and a rotation must cost
   * one refetch rather than every login until the TTL lapses. That is the same "bounded by a
   * probe, not indefinite" property that keeps `fragmentDocumentBody` and `repoFiles` enabled on
   * the Worker, so this slice stays ENABLED there too — a peer isolate holding a pre-rotation
   * key set heals on its own next login instead of failing until eviction.
   */
  ssoDiscovery: GroupCacheHandle<SsoDiscoveryDocument>
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
 * Cache-friendly wrapper for a model-preset read (`null` ⇒ the preset id doesn't resolve — a
 * deleted selected id or an unseeded workspace's absent default — so the caller falls through,
 * exactly as an uncached read would).
 */
export interface ModelPresetCacheValue {
  preset: ModelPreset | null
}

/**
 * Cache-friendly wrapper for one user's local-model declarations: only the runners that have a
 * model enabled, each with the declarations for them.
 *
 * Wrapped rather than cached bare so the common "this user runs no local models" case caches as a
 * VALUE (layered-loader treats a bare `null` as unresolved, and an empty array would be a second
 * shape to reason about), and PROJECTED rather than holding the endpoint records because those
 * carry the sealed bearer key, which has no business in a cache serving the run path.
 */
export interface LocalModelDeclarationsCacheValue {
  runners: LocalModelDeclarations[]
}

/**
 * Read a user's local-model declarations through the {@link AppCaches.localModelDeclarations}
 * slice (or straight from the repository when no cache is wired, as in tests and standalone
 * services). Shared by every reader so the key/group and the projection cannot drift, the same
 * reasoning as {@link readCachedWorkspaceSettings}. Group == key == user id.
 *
 * The result is the SHARED cached instance on a hit, so callers must treat it as immutable.
 */
export async function readCachedLocalModelDeclarations(
  cache: GroupCacheHandle<LocalModelDeclarationsCacheValue> | undefined,
  repository: LocalModelEndpointRepository,
  userId: string,
): Promise<readonly LocalModelDeclarations[]> {
  const load = async (): Promise<LocalModelDeclarationsCacheValue> => {
    const endpoints = await repository.listByUser(userId)
    return {
      runners: endpoints
        .filter((e) => e.models.length > 0)
        .map((e) => ({ provider: e.provider, models: e.models })),
    }
  }
  const { runners } = cache ? await cache.get(userId, userId, load) : await load()
  return runners
}

/**
 * Cache-friendly wrapper for a resolved workspace-RBAC access decision. `access` is `null` when
 * the board does NOT exist (the gate then passes through so the handler 404s as it always has),
 * a `{allowed:false}` denial, or an `{allowed:true}` grant — all three cache as values so a repeat
 * request costs zero reads (the wrap convention, since layered-loader treats a bare `null` as
 * unresolved).
 */
export interface WorkspaceAccessCacheValue {
  access: WorkspaceAccess | null
}

/**
 * Cache-friendly wrapper for a user's session generation. `generation` is `null` for a user the
 * store has no row for, which caches as a value like every other negative case here (layered-loader
 * treats a bare `null` as unresolved).
 *
 * Wrapping matters more than usual on this slice, because the unwrapped values are two NUMBERS and
 * an absence, and the absence is the one that must be authoritative: a deleted user holding an
 * unexpired bearer would otherwise re-read the store on every request they make, which is exactly
 * the hot path this cache exists to keep off it.
 */
export interface SessionGenerationCacheValue {
  generation: number | null
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
