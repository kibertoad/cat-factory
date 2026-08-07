import { describe, expect, it } from 'vitest'
import {
  LOCAL_FIRST_PERSISTENCE_REPOSITORIES,
  REMOTE_PERSISTENCE_METHODS,
} from '@cat-factory/server'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import {
  DrizzleBootstrapJobRepository,
  DrizzleReferenceArchitectureRepository,
} from '../src/repositories/bootstrap.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
  DrizzleServiceFrameRepository,
} from '../src/repositories/containerExecution.js'
import {
  DrizzleBranchProjectionRepository,
  DrizzleCheckRunProjectionRepository,
  DrizzleCommitProjectionRepository,
  DrizzleIssueProjectionRepository,
  DrizzlePullRequestProjectionRepository,
  DrizzleRepoProjectionRepository,
} from '../src/repositories/github.js'
import {
  DrizzleDocumentConnectionRepository,
  DrizzleDocumentRepository,
} from '../src/repositories/documents.js'
import {
  DrizzleEnvironmentConnectionRepository,
  DrizzleEnvironmentRegistryRepository,
} from '../src/repositories/environments.js'
import { DrizzleEnvironmentUserHandlerRepository } from '../src/repositories/environmentUserHandler.js'
import { DrizzleEnvConfigRepairJobRepository } from '../src/repositories/envConfigRepair.js'
import { DrizzleEnvironmentTestRunRepository } from '../src/repositories/environmentTest.js'
import { DrizzleCustomManifestTypeRepository } from '../src/repositories/customManifestType.js'
import {
  DrizzleFragmentBriefRepository,
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from '../src/repositories/fragments.js'
import {
  DrizzleApiContractRepository,
  DrizzleFoundationalServiceRepository,
  DrizzleFoundationalServiceSourceRepository,
} from '../src/repositories/foundationalServices.js'
import {
  DrizzleAccountSkillRepository,
  DrizzleSkillSourceRepository,
} from '../src/repositories/skills.js'
import { DrizzleNotificationRepository } from '../src/repositories/notifications.js'
import {
  DrizzleNotificationWebhookRepository,
  DrizzleReviewQuestionPostRepository,
  DrizzleTrackerCommentIngestRepository,
} from '../src/repositories/drizzle/settings.js'
import {
  DrizzleSlackConnectionRepository,
  DrizzleSlackMemberMappingRepository,
  DrizzleSlackSettingsRepository,
} from '../src/repositories/slack.js'
import {
  DrizzleTaskConnectionRepository,
  DrizzleTaskRepository,
  DrizzleTaskSourceSettingsRepository,
} from '../src/repositories/tasks.js'
import { DrizzleProviderApiKeyRepository } from '../src/repositories/providerApiKey.js'
import { DrizzleProviderModelCatalogRepository } from '../src/repositories/providerModelCatalog.js'
import { DrizzleProviderSubscriptionTokenRepository } from '../src/repositories/providerSubscription.js'
import {
  DrizzlePersonalSubscriptionRepository,
  DrizzleSubscriptionActivationRepository,
} from '../src/repositories/personalSubscription.js'
import { DrizzleLocalModelEndpointRepository } from '../src/repositories/localModelEndpoint.js'
import { DrizzleUserSecretRepository } from '../src/repositories/userSecret.js'
import { DrizzleUserRepoAccessRepository } from '../src/repositories/userRepoAccess.js'

// ---------------------------------------------------------------------------
// Mothership-mode allow-list completeness guard (docs/initiatives/mothership-mode.md).
//
// The behavioural `[mothership]` conformance suite proves the run-path repository methods are
// correctly proxied — but only for methods a flow actually exercises. THIS test is the
// coverage-independent backstop: it reflects EVERY public method of EVERY Drizzle repository and
// requires each to be CLASSIFIED exactly once — either it is in the server-side allow-list
// (`REMOTE_PERSISTENCE_METHODS`, i.e. remotely callable), or it is in `NON_REMOTE` with an explicit
// reason (telemetry / local-sqlite / admin-gated / sweeper / pending / inbound / helper).
//
// So adding a new Drizzle repository or method WITHOUT a deliberate decision fails this test: the
// author must either allow-list it (proxy it to the mothership) or record why it stays off the
// machine API. That is the "you forgot to proxy it" guarantee, independent of whether any
// behavioural test happens to call the new method.
//
// The guarantee has one edge the assertions cannot reach on their own: a repository absent from the
// reflection below is invisible to ALL of it, so `nonCore` is the load-bearing half. Two marker
// stores sat outside it until the sealed-connection work went looking, which is why the classes are
// listed rather than the classifications.
// ---------------------------------------------------------------------------

type Reason =
  // Org/durable, REMOTE, but not allow-listed yet — the explicit surface-completion backlog. A
  // new org method lands here until a slice proxies it (with a scope rule + conformance coverage).
  | 'pending'
  // A per-USER credential/secret store kept on the laptop (`node:sqlite`), never the mothership.
  | 'local'
  // High-volume / local-first telemetry: a mothership-mode node writes AND reads it in its own
  // `node:sqlite` telemetry store (docs/initiatives/mothership-mode.md, PR 5), so neither the
  // writes nor the reads ever hit the per-call RPC. NOT a backlog state — this is the bucket's
  // permanent home, unlike `pending`.
  | 'telemetry'
  // Admin-gated mutation: the machine token scopes ACCOUNTS not ROLES, and the RPC bypasses the
  // service-layer `requireAdmin`, so exposing it would let any member self-promote. Mothership-only.
  | 'admin'
  // Global / cron sweeper or unscoped maintenance op — stays mothership-internal.
  | 'sweeper'
  // Onboarding / account-lifecycle op that cannot be account-scoped (creating the account itself).
  | 'onboarding'
  // A non-port implementation helper that is public on the prototype but never called via the
  // repository registry (row mappers, credential decoders, etc.).
  | 'helper'
  // State of an INBOUND delivery path, written only where the delivery ARRIVES. A webhook reaches
  // whichever deployment holds the public URL, which in mothership mode is the mothership; a
  // laptop receives none, so it has nothing to dedupe and never reads these rows. Permanent (the
  // node cannot be the receiver), not a backlog state.
  | 'inbound'

// Every repository method that is NOT in the allow-list, with the reason it stays off the machine
// API. Keep in sync with the reflected surface — a NEW method missing from BOTH this map and the
// allow-list fails the partition assertion below.
const NON_REMOTE: Record<string, Record<string, Reason>> = {
  // `setAccessMode` / `linkAccount` are the workspace-RBAC roster writes — `members.manage`
  // (admin-tier), so they stay off the role-blind machine RPC exactly like the account/membership
  // admin mutations. `linkAccount` is the legacy-board auto-heal (adopt into an account).
  workspaceRepository: {
    create: 'onboarding',
    delete: 'sweeper',
    setAccessMode: 'admin',
    linkAccount: 'admin',
  },
  accountRepository: {
    create: 'onboarding',
    ensurePersonal: 'onboarding',
    rename: 'admin',
    updateSettings: 'admin',
  },
  membershipRepository: { upsert: 'admin', remove: 'admin' },
  // Workspace-RBAC member tier (slice 3). The gate's per-request `get` + the list-annotation
  // `getRolesForUserInWorkspaces` are now allow-listed (REMOTE_PERSISTENCE_METHODS — the two
  // reads that run on every signed edge request). The roster reads back the member-management
  // API (a later slice, no SPA path yet → pending), and the mutations are admin-gated member
  // management — the machine token is role-blind, so exposing them would let a member self-grant,
  // exactly like `membershipRepository.upsert`/`remove`.
  workspaceMemberRepository: {
    listByWorkspace: 'pending',
    listWorkspaceIdsForUser: 'pending',
    upsert: 'admin',
    remove: 'admin',
    removeByAccountMembership: 'admin',
  },
  // `get`/`listByIds` are now allow-listed (the member-display reads: the account members panel's
  // roster enrichment + the single-user display lookup, bound by co-membership via the `user`/
  // `userList` scope rules). They carry only the presentational `UserRecord` — the password
  // `secret` lives on `UserIdentityRecord`, read only via `getIdentity`/`listIdentities` (kept off).
  // `update` (profile write) + `findByIdentity`/`findByEmail`/`getIdentity`/`listIdentities` are the
  // account-lifecycle / login surface (the identity reads leak the hash), so they stay off.
  userRepository: {
    create: 'onboarding',
    update: 'pending',
    findByIdentity: 'pending',
    findByEmail: 'pending',
    getIdentity: 'pending',
    linkIdentity: 'onboarding',
    listIdentities: 'pending',
    // The session-revocation WRITE. `sessionGeneration` (the read) is allow-listed so a node stops
    // honouring a revoked bearer, but the bump is the revocation itself: a role-blind token that
    // could reach it could sign out every user in its account scope, so it stays mothership-only
    // exactly like the membership mutations above. Permanent, not a backlog state.
    bumpSessionGeneration: 'admin',
  },
  // `listByAccount` is now allow-listed (the account members panel's pending-invite read,
  // member-level). The lifecycle WRITES `create`/`setStatus` are admin-gated (inviting/revoking
  // members), and `get`/`findByTokenHash` are the pre-auth accept-invite lookups (never a
  // scoped-token call) — all stay mothership-internal.
  invitationRepository: {
    create: 'admin',
    get: 'pending',
    findByTokenHash: 'pending',
    setStatus: 'admin',
  },
  passwordResetTokenRepository: {
    create: 'pending',
    findByTokenHash: 'pending',
    listPendingByUser: 'pending',
    setStatus: 'pending',
    consume: 'pending',
    deleteExpired: 'sweeper',
  },
  // The machine-node roster + revocation tombstones (SEC-5) are the machine API's OWN auth
  // state, so none of it may be remotely callable: a node that could reach `revoke` (or worse,
  // `recordMint`) over the RPC could tombstone other tenants' satellites or take over a node
  // id, and `isRevoked` is the very check the gate runs BEFORE dispatch. Mothership-internal
  // by construction: 'admin' rather than 'pending' because this is permanent, not a backlog.
  machineNodeRepository: {
    recordMint: 'admin',
    get: 'admin',
    listByUser: 'admin',
    revoke: 'admin',
    isRevoked: 'admin',
    deleteExpired: 'sweeper',
  },
  // The account audit log. Every action instrumented so far is an ADMIN-gated account mutation
  // (membership, roles, budget/settings, invitations, the board roster), and every one of those
  // repositories is itself 'admin' here for the same stated reason: the machine token scopes
  // ACCOUNTS not ROLES and the RPC bypasses the service-layer `requireAdmin`. An action a node
  // cannot perform needs no route for the audit row that describes it.
  //
  // `append` carries a second, sharper reason not to expose it. The event names its own ACTOR, so
  // a role-blind token that could reach `append` could forge entries attributing any action to
  // any user inside its account scope — which is not a gap in the audit log so much as the end of
  // it. Whenever the run-lifecycle slice audits a node-driven run, the row must be written by the
  // mothership from what it already observes, never accepted from the node's own say-so.
  //
  // `listByAccount` is the admin-tier viewer read, off the machine API exactly like
  // `accountSettingsRepository.getByAccount`. Mothership-internal by construction, not a backlog.
  //
  // `deleteOlderThan` is the retention sweep, which the mothership runs against its own store; a
  // node never drives it, and a node that could reach it could erase the trail that describes it.
  auditEventRepository: { append: 'admin', listByAccount: 'admin', deleteOlderThan: 'sweeper' },
  // The auth-attempt ledger (SEC-4) is the password throttle's own state. A node that could
  // reach it over the RPC could read attempt patterns or flood a victim's bucket; nothing on
  // a satellite ever needs it. Mothership-internal by construction, like the roster above.
  authAttemptRepository: {
    record: 'admin',
    countByKeySince: 'admin',
    countByIpSince: 'admin',
    deleteOlderThan: 'sweeper',
  },
  // `getByAccount` is now allow-listed (the email-settings panel's member-level read; the record's
  // provider key rides a SEALED `apiKeyCipher` blob, so no plaintext crosses the machine API).
  // `upsert`/`softDelete` (connect/disconnect) are admin-gated → stay mothership-internal.
  emailConnectionRepository: { upsert: 'admin', softDelete: 'admin' },
  // `countActiveInternal` (the public API's initiative-start concurrency backstop) is now
  // allow-listed, completing the headless surface whose paginated reads were already remote.
  // The single-service `listByService` has no live consumer (board composition goes through the
  // batched `listByServices`), so exposing it would be dead surface — it stays pending until
  // something actually calls it.
  blockRepository: { listByService: 'pending' },
  pipelineRepository: {},
  executionRepository: { listByService: 'pending', listStale: 'sweeper' },
  // `getRef` is allow-listed (the board's retry/stop run-control entry point). `listStale`/
  // `liveRunIds`/`listPausedExecutions` are the stale-run/paused-resume sweeper's kind-spanning
  // reads — mothership-internal cron. `recordRedrive` is the WRITE half of that same sweep and
  // has no other caller, so it is classified with the reads it accompanies rather than
  // allow-listed: proxying it would expose a counter bump to a node that never runs the sweep
  // that earns it.
  agentRunRepository: {
    listStale: 'sweeper',
    liveRunIds: 'sweeper',
    listPausedExecutions: 'sweeper',
    recordRedrive: 'sweeper',
  },
  // The operator-dashboard rollups are admin-gated reads (`GET /accounts/:id/observability/platform`
  // guards on `requireAdmin`), and the machine RPC bypasses that service-layer gate, so they stay
  // mothership-internal exactly like the account-settings reads. `accountScope` is a private query-
  // scope helper (a `workspaces` sub-select), not a port method.
  platformMetricsRepository: {
    accountScope: 'helper',
    runOutcomesSince: 'admin',
    runOutcomeTrend: 'admin',
    failureKindBreakdown: 'admin',
    activeAndParkedCounts: 'admin',
    durationStatsSince: 'admin',
    dailyRunTotalsSince: 'admin',
    dailyRollupWatermark: 'admin',
    // The failing-run sample feeds the admin-gated alert card, and it is the one read here
    // that returns per-RUN identifiers rather than counts, all the more reason it stays
    // behind the same gate rather than becoming a proxied cross-workspace run listing.
    recentFailedRuns: 'admin',
    // Materialising and pruning the daily rollup are the retention sweep's own writes, which
    // the mothership runs against its own Postgres; a node never drives them.
    rollupRunDays: 'sweeper',
    deleteRunDaysOlderThan: 'sweeper',
  },
  // The settled-gate projection. `record` is the one method a mothership-mode node reaches for
  // (the ENGINE writes it on the run path) and it IS proxied — see `REMOTE_PERSISTENCE_METHODS`.
  // Only the two mothership-internal halves are classified here.
  gateOutcomeRepository: {
    statsSince: 'admin',
    deleteOlderThan: 'sweeper',
  },
  // The Reports rollups are admin-gated reads (`GET /accounts/:id/reports` guards on
  // `requireAdmin`) exactly like the operator-dashboard ones above, so they stay
  // mothership-internal for the same reason. The three `*Where`/`accountWorkspaceIds` entries are
  // private query-scope helpers (the account sub-select and the two window predicates), not port
  // methods.
  reportsRepository: {
    accountWorkspaceIds: 'helper',
    ledgerWhere: 'helper',
    runWhere: 'helper',
    spendByDimension: 'admin',
    activityByDimension: 'admin',
    spendTrend: 'admin',
  },
  // The durable cost-attribution rollup. Its two READS serve the same admin-gated Reports
  // endpoint as the ledger-side ones above, so they stay mothership-internal for the same
  // reason. Materialising it is the retention sweep's own write, which the mothership runs
  // against its own Postgres; a node never drives it, and there is no prune to classify
  // because the table has none. The per-workspace fold rides `workspaceRepository.delete`,
  // which is itself mothership-internal, so a node never reaches it either. `scopeWhere` is a
  // private query-scope helper.
  spendRollupRepository: {
    scopeWhere: 'helper',
    spendByDimension: 'admin',
    spendTrend: 'admin',
    spendRollupWatermark: 'admin',
    rollupSpendDays: 'sweeper',
    rollupWorkspaceSpendDays: 'sweeper',
  },
  // The spend LEDGER is the one member of the telemetry family that is NOT local-first: it is the
  // org's budget safeguard, and its three rollups are read remotely by the spend gate, so `record`
  // is allow-listed (under the `usageRecord` rule, which pins the row's denormalized account/user
  // to the caller). Only the deployment-wide sweeps stay mothership-internal.
  // The two batched forecast reads take a SET of scope ids spanning the whole deployment and
  // serve the spend-alert sweep, which runs on the mothership beside the ledger it reads. There is
  // no per-workspace caller to scope them to, and a node has no business asking about tenants it
  // does not own.
  tokenUsageRepository: {
    totalsSince: 'sweeper',
    meteredSpendByWorkspaceSince: 'sweeper',
    meteredSpendByAccountSince: 'sweeper',
    deleteOlderThan: 'sweeper',
  },
  // The three agent-observability sinks are local-first in mothership mode: written on the hot
  // path of every LLM call / dispatch / web search, read back from the same local store by the
  // observability panel and the board's per-step rollups. `summarizeByExecution` used to be a
  // remote stopgap; against the MOTHERSHIP's telemetry store it could only ever report zeros for
  // a laptop's own run, so it moved to the local store with the rest.
  //
  // That makes EVERY read on them `telemetry`, never `pending` — the remote debugging surface's
  // bounded pages (`listPage`/`get`/`listIndex`/`countByExecution`) included. Routing those would
  // be the exact shape the bucket exists to forbid, since a page over a long run is a bulk read of
  // the heaviest columns in the system.
  //
  // `recordMany` is the batch append the mothership performs FOR a node, behind the dedicated
  // `POST /internal/telemetry/ingest` endpoint — not something a node invokes through the generic
  // persistence RPC. Allow-listing it would re-admit exactly the per-row remote write the local-
  // first bucket exists to prevent, so it is classified with the rest of the sink. `listRunPage`
  // is the same story in the READ direction: it is served to a node by the dedicated
  // `POST /internal/telemetry/read`, whose own closed table bounds it. Naming it here would put
  // the whole repository on the remote registry, writes included.
  llmCallMetricRepository: {
    record: 'telemetry',
    recordMany: 'telemetry',
    latestChainTip: 'telemetry',
    listByExecution: 'telemetry',
    listRunPage: 'telemetry',
    summarizeByExecution: 'telemetry',
    listPage: 'telemetry',
    get: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  agentContextSnapshotRepository: {
    record: 'telemetry',
    recordMany: 'telemetry',
    listByExecution: 'telemetry',
    listRunPage: 'telemetry',
    listIndex: 'telemetry',
    get: 'telemetry',
    countByExecution: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  agentSearchQueryRepository: {
    record: 'telemetry',
    recordMany: 'telemetry',
    listByExecution: 'telemetry',
    listPage: 'telemetry',
    countByExecution: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  // The tool-call trajectory: the same local-first bucket as the three sinks above, for the same
  // reason — it is captured on the run's hot path (one batch per job poll) and read back locally
  // by the node's own debug surface, so a per-batch RPC would put the mothership on the poll path.
  agentToolCallRepository: {
    recordMany: 'telemetry',
    listByExecution: 'telemetry',
    listPage: 'telemetry',
    summarizeByExecution: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  // Modeled subscription quota-cycle counters (usage-and-quota-tracking, Part B): the
  // windowed usage write + its scoped read are provider-mediated telemetry that never
  // crosses the per-call RPC (the B3 quota endpoint reads through the provider's `report`,
  // not this repo directly); the retention prune is a sweeper op. Local by construction as
  // well as by policy in mothership mode: BOTH scopes a cycle keys on (a pooled subscription
  // token, a user's personal one) live in the laptop's own credential store.
  subscriptionQuotaCycleRepository: {
    recordUsage: 'telemetry',
    listByScopeVendor: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  // The visual-confirmation gate's artifact METADATA surface is now allow-listed (insert/get/
  // listByExecution/countByExecution/listByBlock/delete — the controllers + gate reads/writes);
  // only the retention/lifecycle reclaim ops stay mothership-internal (the mothership owns
  // durable-state retention): the age-based retention sweep (listOlderThan/deleteOlderThan) and
  // the workspace-delete purge (listByWorkspace/deleteByWorkspace, driven server-side by
  // `WorkspaceService.delete`). The blob BYTES never cross the machine API — they live in the
  // per-account backend.
  // `documentScope`/`agedScope` are private query-scope predicates (the document reclaim's filter
  // and the age sweep's), not port methods.
  binaryArtifactMetadataStore: {
    listOlderThan: 'sweeper',
    deleteOlderThan: 'sweeper',
    listByWorkspace: 'sweeper',
    deleteByWorkspace: 'sweeper',
    documentScope: 'helper',
    agedScope: 'helper',
  },
  // `get`/`remove` are now allow-listed (the preset-library management surface); `list`/`getDefault`/
  // `upsert` were already remotely callable — so the whole model-preset repo is remote.
  modelPresetRepository: {},
  // `set` is now allow-listed (the fragment-defaults editor); `get` was already remote.
  serviceFragmentDefaultsRepository: {},
  pipelineScheduleRepository: {
    values: 'helper',
    // `get`/`upsert`/`remove`/`insertRun`/`updateRun`/`listRuns` are now allow-listed (the
    // recurring-schedule management surface incl. `runNow`); the serviceId-keyed `listByService`
    // stays off the SPA path and the sweeper reads/prunes stay mothership-internal.
    listByService: 'pending',
    listDue: 'sweeper',
    pruneRunsBefore: 'sweeper',
  },
  // `put` is now allow-listed (the tracker-settings editor); `get` was already remote.
  trackerSettingsRepository: {},
  serviceRepository: {
    // `get`/`listByIds`/`listByAccount`/`getByFrameBlock`/`listByFrameBlocks` are allow-listed (the
    // org-catalog mount flow + board composition + run-path frame resolution + the batched
    // duplicate-service / frame-deletion read). The remaining CRUD + `getByRepo` (the GitHub-sync
    // repo→service link) stay off the SPA path — a later slice.
    getByRepo: 'pending',
    insert: 'pending',
    update: 'pending',
    delete: 'pending',
    deleteMany: 'pending',
  },
  workspaceMountRepository: {
    // `listByWorkspace`/`countByServiceIds`/`get`/`upsert`/`update`/`remove` are allow-listed (the
    // shared-service mount management surface), and `listWorkspaceIdsMountingBlock` now joins them
    // — the real-time fan-out calls it on EVERY publish, so it was never optional. The unbatched
    // `listByService` has no remaining consumer on that path; the frame-deletion batch cleanup
    // (`removeByServices`) and the board-delete cascade's batched read (`listByServiceIds`, used by
    // `planSharedServiceRehome`) stay off because their surrounding flows — service CRUD and
    // workspace delete — are themselves still mothership-internal.
    listByService: 'pending',
    listByServiceIds: 'pending',
    removeByServices: 'pending',
  },
  // The whole requirement-review repo is remote (getByBlock/get/upsert were exposed earlier; the
  // rev-guarded compareAndSwap — which every review edit now rides — and the atomic
  // replaceForBlock that starts a fresh review run complete it).
  requirementReviewRepository: {},
  // `listByWorkspace`/`listByExecution` are now allow-listed (the Kaizen screen's grading-history
  // + per-run status reads); `getByStep`/`upsert` were already remote (the run-path grade). The
  // single-grade `get` is internal-only (no SPA path); `listPending`/`claim` are the sweep's reads.
  kaizenGradingRepository: {
    get: 'pending',
    listPending: 'sweeper',
    claim: 'sweeper',
  },
  // `listByWorkspace` is now allow-listed (the Kaizen screen's verified-combo library); `getByKey`
  // was already remote. `upsert` is the background sweep's streak write — best-effort in mothership
  // mode until Phase 5.
  kaizenVerifiedComboRepository: { upsert: 'pending' },
  // The advanced review / structured-dialogue session surfaces are now fully remote (run + re-read
  // + persist/replace as the window iterates) — get/getByStep/getByBlock/upsert for consensus,
  // get/upsert/compareAndSwap/replaceFor* for clarity + brainstorm (getByBlock/getByBlockStage
  // were already exposed).
  consensusSessionRepository: {},
  // The consensus-GROUP library is fully remote: the settings editor's CRUD plus the engine's
  // per-dispatch `listByIds`, which resolves a tiered step's candidate panels on the RUN path.
  consensusGroupRepository: {},
  clarityReviewRepository: {},
  brainstormSessionRepository: {},
  // The workspace-scoped CRUD + rev-CAS surface is allow-listed; only the cross-workspace
  // cron sweeper read stays mothership-internal.
  initiativeRepository: { listExecuting: 'sweeper' },
  // `get`/`remove` are now allow-listed (the preset-library management surface); `list`/`getDefault`/
  // `upsert` were already remotely callable — so the whole merge-preset repo is remote.
  riskPolicyRepository: {},
  // `upsert` is now allow-listed (the workspace-settings panel save); `get` was already remote.
  // `listByWorkspaceIds` is the notification-escalation sweep's batched every-workspace read — a
  // global cron sweeper read, so it stays mothership-internal like the other `'sweeper'` entries.
  workspaceSettingsRepository: { listByWorkspaceIds: 'sweeper' },
  // The whole observability / incident-enrichment connection + per-block release-health config
  // surface is now allow-listed (the post-release-health settings panels' get/upsert/delete),
  // so these repos are fully remote — get/getByBlock/listByWorkspace/delete via the `workspace`
  // rule, the record-based `upsert` via the `workspaceField` rule.
  observabilityConnectionRepository: {},
  incidentEnrichmentConnectionRepository: {},
  // The private package-registry connection surface is fully remote too (the registries
  // panel's get/upsert/delete + the container dispatch's decrypt-time get).
  packageRegistryConnectionRepository: {},
  // Account settings (the per-account deployment secrets/tuning: Slack/Linear OAuth, web-search
  // keys, Langfuse). Both the READ (`getByAccount`) and the WRITE (`upsert`) endpoints are
  // admin-gated (`AccountController` guards `/accounts/:id/settings` GET+PUT with `requireAdmin`),
  // and the machine token scopes ACCOUNTS not ROLES while the RPC bypasses the service-layer
  // `requireAdmin` — so exposing either would let any account member read/rewrite the account's
  // secrets over the wire. They stay mothership-internal until a later slice adds a role dimension
  // to the scope (or routes them through the service), exactly like `accountRepository.updateSettings`.
  // `listAll` is the global cross-account sweep.
  accountSettingsRepository: { getByAccount: 'admin', upsert: 'admin', listAll: 'sweeper' },
  releaseHealthConfigRepository: {},
  // The sealed sensitive test-credential surface is allow-listed for the inspector CRUD +
  // run-path frame read (`getByBlock`/`upsert`/`deleteByBlock` — the sealed blob rides the
  // machine API, decrypted service-side under the LOCAL key). `listByWorkspace` has no consumer
  // on any SPA/run path yet, so it stays pending until a slice needs it.
  testSecretsRepository: { listByWorkspace: 'pending' },
  // Pre-PR validation checks: the whole surface is allow-listed (the inspector CRUD + the
  // dispatch's frame read). Nothing sealed — the commands are operator-authored shell strings
  // that run inside the run's own container — so the plain record rides the machine API.
  validationConfigRepository: {},
  // The provisioning event log is local-first too, and unusually literally so: in mothership mode
  // the containers/environments it records are provisioned BY THIS NODE, so the rows describe local
  // infrastructure and the panels that read them ("View logs") want exactly this machine's history.
  // The debug surface's `countByExecution` reads that same local history.
  provisioningLogRepository: {
    append: 'telemetry',
    list: 'telemetry',
    countByExecution: 'telemetry',
    deleteOlderThan: 'sweeper',
  },
  // --- non-core repositories -----------------------------------------------------
  // `get`/`insert`/`update` are now allow-listed (the bootstrap start / board-card poll / retry /
  // stop surface); `listByWorkspace`/`listByServices` were already remote. `blockServiceId` is a
  // row-mapping helper; the serviceId-keyed `listByService` stays off the SPA path.
  bootstrapJobRepository: {
    blockServiceId: 'helper',
    listByService: 'pending',
  },
  // The whole reference-architecture library is now remote (the bootstrap modal's CRUD + the
  // retry re-resolve): get/listByWorkspace/insert/update/softDelete.
  referenceArchitectureRepository: {},
  // `getByWorkspace` is now allow-listed: `resolveRepoTarget` reads it FIRST on every
  // container-agent dispatch (installation → then the `github_repos` projection), so the
  // run path needs it alongside `repoProjectionRepository.list`. The installationId-keyed
  // reads, the sync/token writes, the webhook fan-out, and the cron `listActive` stay off
  // (a later GitHub sync + repo-write slice — the mothership owns App + webhooks).
  githubInstallationRepository: {
    getByInstallationId: 'pending',
    listByInstallationIds: 'pending',
    listWorkspacesForInstallation: 'pending',
    listActive: 'sweeper',
    upsert: 'pending',
    updateCachedToken: 'pending',
    softDelete: 'pending',
  },
  serviceFrameRepository: { getByFrameBlock: 'pending' },
  // The whole self-hosted runner-backend connection surface is now remote (the runner-pool
  // settings panel's connect/rotate/disconnect): getByWorkspace/softDelete via the `workspace`
  // rule, the record-based `upsert` via the `workspaceField` rule. Its credentials ride a SEALED
  // `secretsCipher` blob (sealed/decrypted in the service under the LOCAL key), so no plaintext
  // crosses the machine API — the same precedent as the observability / environment connections.
  runnerPoolConnectionRepository: {},
  // The whole documents surface is now remote: the run-path context reads, the import/link WRITE
  // path and its batched siblings, and the WS1 role-link management surface.
  documentRepository: {},
  // The workspace's document-source connections. Previously ALL pending, and not for want of a
  // scope rule: the repository decrypted INSIDE, so a proxied read would have put a plaintext
  // Figma/Confluence token on the wire. The row now carries its bag SEALED and the node opens it
  // over `/internal/secrets/unseal` (`document_source_connection`), which is the same shape the
  // environment / observability / Slack / runner-pool connections already used.
  documentConnectionRepository: {
    rowToRecord: 'helper',
  },
  // `get`/`insert`/`update` are now allow-listed (the repair retry/stop run-control surface);
  // `listByWorkspace` was already remote (the run-path list). The whole repo is now remote.
  envConfigRepairJobRepository: {},
  // The ephemeral-environment self-test run store is remote (insert/updateIfRunning/get/
  // listRunningByWorkspace — the start / durable-poll / stop surface + the snapshot's
  // in-flight read). Its GitHub dependency (`resolveRunRepoContext` for the throwaway
  // branch) is served by mothership GitHub token delegation
  // (`/internal/github/installation-token`), so the old "needs GitHub which mothership does
  // not proxy" blocker is gone; the remaining gate on a FULL mothership-mode self-test is
  // the provisioning writes, now remote (`environmentRegistryRepository.insert`/`update`).
  // `listStale` is the stale-run cron sweeper's cross-workspace read (mirrors
  // `agentRunRepository.listStale`): mothership-internal.
  environmentTestRunRepository: { listStale: 'sweeper' },
  // The whole environment-connection management surface is now remote (the connection +
  // per-type infra-handler settings panels: list/connect/disconnect/register-handler). Its
  // secrets ride a SEALED `secretsCipher` blob, so no plaintext credential crosses the machine
  // API; the bundle is OPENED on the node by the mothership over `/internal/secrets/unseal`
  // (the secrets-delegation slice), which is also what made the provisioning WRITES below safe.
  environmentConnectionRepository: {},
  environmentRegistryRepository: {
    // `insert`/`update`/`softDelete` are now allow-listed (REMOTE_PERSISTENCE_METHODS): the
    // provisioning write path and its tombstone. Safe because the row's
    // `accessCipher`/`provisionFieldsCipher` are sealed BY THE MOTHERSHIP over
    // `/internal/secrets/seal`, so a laptop-provisioned environment stays readable by the org
    // (and reclaimable by the mothership's own teardown).
    // listByWorkspace is now allow-listed (REMOTE_PERSISTENCE_METHODS) — the frontend UI-test
    // gate's batch env read + the environments list endpoint. Classified there, not here.
    listExpired: 'sweeper',
  },
  environmentUserHandlerRepository: {
    listByUserWorkspace: 'local',
    upsert: 'local',
    remove: 'local',
  },
  // `listByOwner`/`upsert` are now allow-listed (the fragment-source library's list + link, owner
  // scoped). The `sourceId`-keyed `get`/`updateSyncState`/`softDelete` back the repo-SYNC management
  // the mothership owns (its source service needs a GitHub client a mothership node lacks) — they
  // stay pending until a GitHub-sync-in-mothership slice adds a source→owner resolver.
  fragmentSourceRepository: {
    get: 'pending',
    updateSyncState: 'pending',
    softDelete: 'pending',
  },
  // Foundational services (backend/docs/adr/0031-foundational-services.md). The owner-scoped
  // catalog + contract reads/writes ARE allow-listed (org/durable state a RUN reads: a
  // mothership-mode architect resolves the catalog and its coder resolves the declared
  // services' contracts over the RPC). What stays off is the repo-SYNC surface, for exactly the
  // reason the fragment library's does — a sync needs a GitHub client a mothership node lacks,
  // and none of these methods carries an `(ownerKind, ownerId)` pair for a scope rule to bind.
  foundationalServiceRepository: {
    listBySource: 'pending',
    softDeleteBySource: 'pending',
  },
  foundationalServiceSourceRepository: {
    get: 'pending',
    updateSyncState: 'pending',
    softDelete: 'pending',
    // The autorefresh sweep's query: global (across every tier) and unscoped by construction.
    listStale: 'sweeper',
    // The push-webhook freshness fan-out's query, keyed on the repo a delivery names and
    // deliberately global across tiers. It runs where the webhook is RECEIVED — never on a
    // mothership-mode node, which has neither the delivery nor the GitHub client the resync
    // it triggers would need.
    listByRepo: 'sweeper',
  },
  // `listByOwner`/`get`/`upsert`/`softDelete` are now allow-listed (the prompt-fragment library
  // management surface, owner scoped, member-level, no secrets). The `sourceId`-keyed `listBySource`
  // is the repo-sync fan-out read (mothership-owned sync) — stays pending.
  promptFragmentRepository: {
    listBySource: 'pending',
  },
  // The repo-sourced Claude Skills library (ADR 0024) is fully remote — catalog reads AND the
  // repo-sync surface, which the sibling libraries above still defer. A mothership-mode node HAS a
  // GitHub client (the delegated App token rides the same machine API), so its `SkillSourceService`
  // assembles and its link/sync/unlink routes are live; the sourceId-keyed methods bind through the
  // `skillSource` scope rule (source → owning account, resolved server-side).
  //
  // `listByRepo` is the one exception: the push-webhook's GLOBAL `(repoOwner, repoName)` → sources
  // reverse lookup, spanning every account by construction, so no rule can bind it. It runs on the
  // mothership that receives the webhook, never on a laptop.
  accountSkillRepository: {},
  skillSourceRepository: { listByRepo: 'sweeper' },
  // The inbox's read/act/dismiss/escalate surface is fully remote (see REMOTE_PERSISTENCE_METHODS);
  // only the cron sweeps stay mothership-internal: the retention prune of resolved cards, and
  // `listOpenByType` — the platform-health sweep's batched every-workspace dedup read (the
  // block-less analogue of `workspaceSettingsRepository.listByWorkspaceIds`, a global sweeper read).
  // `listLatestByType` joins its open-only sibling: both are the cross-workspace batched reads the
  // platform-health and spend-alert sweeps make once per pass, never a per-workspace SPA call.
  notificationRepository: {
    deleteResolvedOlderThan: 'sweeper',
    listOpenByType: 'sweeper',
    listLatestByType: 'sweeper',
  },
  // The Slack management surface is now remote (the settings panels' connect/disconnect/route/map):
  // `slackConnectionRepository` get/upsert/softDelete (sealed `tokenCipher` — no plaintext crosses
  // the machine API), and the secret-free settings + member-mapping repos. `getByTeam` is the GLOBAL
  // teamId → connection lookup the inbound OAuth callback / event webhook use on the mothership (never
  // the laptop); it cannot be account-scoped, so it stays mothership-internal — the same "unscoped,
  // mothership-internal" bucket as `repoProjectionRepository.listByInstallation`.
  slackConnectionRepository: { getByTeam: 'sweeper' },
  slackSettingsRepository: {},
  slackMemberMappingRepository: {},
  // The whole tasks surface is now remote: the run-path context reads, the import/link writes and
  // the atomic `claimBlockLink` that holds one-task-per-ticket, plus both unlink forms.
  taskRepository: {},
  // The tracker connections, on the same sealed-row argument as their document-source sibling
  // above (`task_source_connection`).
  taskConnectionRepository: {
    rowToRecord: 'helper',
  },
  taskSourceSettingsRepository: {
    rowToRecord: 'helper',
  },
  // The tracker writeback's idempotency marker for a parked review's question comments. The ENGINE
  // writes it, so a mothership-mode node genuinely reaches it (unlike its ingest sibling below) and
  // it is already routed through `pickRepoSource` — but the methods are not allow-listed yet, so a
  // claim answers `unknown_method` and `postReviewQuestions` degrades to "someone else holds the
  // claim", loudly. A real backlog item: allow-listing it needs a scope rule keyed on the marker's
  // own workspace plus conformance coverage of the claim/settle race.
  reviewQuestionPostRepository: {
    where: 'helper',
    claim: 'pending',
    settle: 'pending',
    get: 'pending',
  },
  // The INBOUND half of the same idea: dedupe for tracker comments arriving by webhook. It rides
  // `'inbound'` rather than `'pending'` because there is nothing to complete — a delivery reaches
  // the deployment holding the public URL, which is the mothership, and a laptop that receives no
  // delivery has nothing to claim. `where` is a private predicate helper, not a port method.
  trackerCommentIngestRepository: {
    where: 'helper',
    claim: 'inbound',
    settle: 'inbound',
    get: 'inbound',
  },
  // The whole custom-manifest-type catalog is now remote (the environments management panel's
  // infra-configurator reads/edits it — no secrets, just manifest metadata).
  customManifestTypeRepository: {},
  // `list` is now allow-listed (the SPA's repos panel + the run-path `resolveRepoTarget` walk of
  // the `github_repos` projection). The board-linkage write (`setMonorepo`), the sync ingest
  // (`upsertMany`/`tombstoneMissing`), the installationId-keyed cursors, the fan-out
  // `linkedWorkspaces`, and the single-repo `get` (repo-write facade only) stay off the SPA path
  // — a later GitHub sync + repo-write slice; `listStale` is the reconcile sweeper's read.
  repoProjectionRepository: {
    upsertMany: 'pending',
    get: 'pending',
    linkedWorkspaces: 'pending',
    tombstoneMissing: 'pending',
    setMonorepo: 'pending',
    listStale: 'sweeper',
    // The GitHub-delegation mint's mothership-side repo-scoping read (`repository_ids`):
    // unscoped across an installation's workspaces, so it must stay mothership-internal —
    // exposing it over the RPC would leak repo rows past the per-call workspace scoping.
    listByInstallation: 'sweeper',
    getCursor: 'pending',
    setCursor: 'pending',
  },
  // The projection READS the SPA's VCS board panels display are now allow-listed
  // (`branchProjectionRepository.listByRepo`, `pullRequest`/`issueProjectionRepository`
  // `.listByWorkspace`). The `upsertMany` sync ingest + the per-repo `listByRepo` variants the
  // panels don't drive stay off — the mothership owns GitHub sync (a later sync-write slice).
  branchProjectionRepository: { upsertMany: 'pending' },
  pullRequestProjectionRepository: {
    upsertMany: 'pending',
    rowToPr: 'helper',
    listByRepo: 'pending',
  },
  issueProjectionRepository: {
    upsertMany: 'pending',
    rowToIssue: 'helper',
    listByRepo: 'pending',
  },
  commitProjectionRepository: {
    upsertMany: 'pending',
    deleteOlderThan: 'sweeper',
    listByRepo: 'pending',
  },
  checkRunProjectionRepository: { upsertMany: 'pending', listBySha: 'pending' },
  // --- per-user local-sqlite credential stores (never proxied) --------------------
  providerApiKeyRepository: {
    listByScope: 'local',
    listForPool: 'local',
    listConfiguredProviders: 'local',
    getById: 'local',
    add: 'local',
    markLeased: 'local',
    leaseLeastUsed: 'local',
    recordUsage: 'local',
    setEnabled: 'local',
    setDefault: 'local',
    softDelete: 'local',
  },
  localModelEndpointRepository: {
    listByUser: 'local',
    getByUserProvider: 'local',
    upsert: 'local',
    remove: 'local',
  },
  providerSubscriptionTokenRepository: {
    listByVendor: 'local',
    getById: 'local',
    add: 'local',
    markLeased: 'local',
    recordUsage: 'local',
    setEnabled: 'local',
    setDefault: 'local',
    softDelete: 'local',
  },
  personalSubscriptionRepository: {
    getByUserVendor: 'local',
    listByUser: 'local',
    upsert: 'local',
    markUsed: 'local',
    softDelete: 'local',
    listExpiring: 'local',
  },
  subscriptionActivationRepository: {
    get: 'local',
    upsert: 'local',
    refresh: 'local',
    deleteByExecution: 'local',
    deleteExpired: 'local',
  },
  userSecretRepository: {
    listByUser: 'local',
    getByUserKind: 'local',
    upsert: 'local',
    remove: 'local',
  },
  // Per-user PAT-reachable repo projection: a personal store consulted for board redaction +
  // picker expansion. A local-first per-user store (like the secret / local-model stores), not
  // proxied org state — the mothership node degrades redaction to "visible" without it.
  userRepoAccessRepository: {
    replaceForUser: 'local',
    recordAccessible: 'local',
    listAccessibleRepoIds: 'local',
    listByUser: 'local',
    removeForUser: 'local',
  },
  providerModelCatalogRepository: {
    getByWorkspace: 'local',
    listByWorkspace: 'local',
    upsert: 'local',
    remove: 'local',
  },
}

/** Reflect the public (port) method names off a repository instance or prototype. */
function publicMethods(target: object): string[] {
  const proto =
    Object.getPrototypeOf(target) === Object.prototype ? target : Object.getPrototypeOf(target)
  return Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' && typeof (proto as Record<string, unknown>)[name] === 'function',
  )
}

/** Build `repoName -> [methods]` from the canonical core set plus the non-core repositories. */
function reflectAllRepositories(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  // The core repositories (only surfaced as instances via `createDrizzleRepositories`).
  const core = createDrizzleRepositories(undefined as never, { now: () => 0 }) as unknown as Record<
    string,
    object
  >
  for (const [name, instance] of Object.entries(core)) {
    // Skip the prompt-testing sandbox repos: they are not org/durable mothership state.
    if (name.startsWith('sandbox')) continue
    out[name] = publicMethods(instance)
  }
  // Non-core repositories the engine routes remotely / keeps local. Keyed by the name the engine
  // (and the allow-list) addresses them by. We only reflect their `.prototype` (never construct),
  // so the value type is just "a class with a prototype" — constructor arity is irrelevant.
  const nonCore: Record<string, { prototype: object }> = {
    bootstrapJobRepository: DrizzleBootstrapJobRepository,
    referenceArchitectureRepository: DrizzleReferenceArchitectureRepository,
    githubInstallationRepository: DrizzleGitHubInstallationRepository,
    runnerPoolConnectionRepository: DrizzleRunnerPoolConnectionRepository,
    serviceFrameRepository: DrizzleServiceFrameRepository,
    repoProjectionRepository: DrizzleRepoProjectionRepository,
    branchProjectionRepository: DrizzleBranchProjectionRepository,
    pullRequestProjectionRepository: DrizzlePullRequestProjectionRepository,
    issueProjectionRepository: DrizzleIssueProjectionRepository,
    commitProjectionRepository: DrizzleCommitProjectionRepository,
    checkRunProjectionRepository: DrizzleCheckRunProjectionRepository,
    documentRepository: DrizzleDocumentRepository,
    documentConnectionRepository: DrizzleDocumentConnectionRepository,
    environmentRegistryRepository: DrizzleEnvironmentRegistryRepository,
    environmentConnectionRepository: DrizzleEnvironmentConnectionRepository,
    environmentUserHandlerRepository: DrizzleEnvironmentUserHandlerRepository,
    envConfigRepairJobRepository: DrizzleEnvConfigRepairJobRepository,
    environmentTestRunRepository: DrizzleEnvironmentTestRunRepository,
    customManifestTypeRepository: DrizzleCustomManifestTypeRepository,
    fragmentBriefRepository: DrizzleFragmentBriefRepository,
    fragmentSourceRepository: DrizzleFragmentSourceRepository,
    foundationalServiceRepository: DrizzleFoundationalServiceRepository,
    apiContractRepository: DrizzleApiContractRepository,
    foundationalServiceSourceRepository: DrizzleFoundationalServiceSourceRepository,
    promptFragmentRepository: DrizzlePromptFragmentRepository,
    accountSkillRepository: DrizzleAccountSkillRepository,
    skillSourceRepository: DrizzleSkillSourceRepository,
    notificationRepository: DrizzleNotificationRepository,
    notificationWebhookRepository: DrizzleNotificationWebhookRepository,
    slackConnectionRepository: DrizzleSlackConnectionRepository,
    slackSettingsRepository: DrizzleSlackSettingsRepository,
    slackMemberMappingRepository: DrizzleSlackMemberMappingRepository,
    taskRepository: DrizzleTaskRepository,
    taskConnectionRepository: DrizzleTaskConnectionRepository,
    taskSourceSettingsRepository: DrizzleTaskSourceSettingsRepository,
    reviewQuestionPostRepository: DrizzleReviewQuestionPostRepository,
    trackerCommentIngestRepository: DrizzleTrackerCommentIngestRepository,
    providerApiKeyRepository: DrizzleProviderApiKeyRepository,
    providerModelCatalogRepository: DrizzleProviderModelCatalogRepository,
    providerSubscriptionTokenRepository: DrizzleProviderSubscriptionTokenRepository,
    personalSubscriptionRepository: DrizzlePersonalSubscriptionRepository,
    subscriptionActivationRepository: DrizzleSubscriptionActivationRepository,
    localModelEndpointRepository: DrizzleLocalModelEndpointRepository,
    userSecretRepository: DrizzleUserSecretRepository,
    userRepoAccessRepository: DrizzleUserRepoAccessRepository,
  }
  for (const [name, Cls] of Object.entries(nonCore)) {
    out[name] = publicMethods(Cls.prototype as object)
  }
  return out
}

const REFLECTED = reflectAllRepositories()

describe('mothership persistence allow-list completeness', () => {
  it('classifies every repository method as remotely-callable or explicitly non-remote', () => {
    const unclassified: string[] = []
    for (const [repo, methods] of Object.entries(REFLECTED)) {
      const allow = REMOTE_PERSISTENCE_METHODS[repo] ?? {}
      const nonRemote = NON_REMOTE[repo] ?? {}
      for (const method of methods) {
        const isAllowed = Object.hasOwn(allow, method)
        const isNonRemote = Object.hasOwn(nonRemote, method)
        if (!isAllowed && !isNonRemote) unclassified.push(`${repo}.${method}`)
      }
    }
    expect(
      unclassified,
      'Every Drizzle repository method must be either allow-listed in REMOTE_PERSISTENCE_METHODS ' +
        '(proxied to the mothership) or recorded in NON_REMOTE with a reason. The methods below are ' +
        'neither — add a scope rule to the allow-list to proxy them, or classify them as ' +
        'pending/local/telemetry/admin/sweeper/onboarding/helper in this test:\n' +
        unclassified.join('\n'),
    ).toEqual([])
  })

  it('has no dead allow-list entries (every allow-listed method exists on its repository)', () => {
    const dead: string[] = []
    for (const [repo, methods] of Object.entries(REMOTE_PERSISTENCE_METHODS)) {
      const reflected = REFLECTED[repo]
      for (const method of Object.keys(methods)) {
        if (!reflected || !reflected.includes(method)) dead.push(`${repo}.${method}`)
      }
    }
    expect(
      dead,
      `allow-list references methods that do not exist on the repository:\n${dead.join('\n')}`,
    ).toEqual([])
  })

  // The local-first telemetry bucket and the remote allow-list are complements, and a repository
  // that drifts into BOTH fails silently in mothership mode: the composition serves the local
  // store, so the allow-listed remote surface is dead — the mothership's own (empty) telemetry
  // would be what a hosted reader sees, while nothing errors. Assert the two stay disjoint, and
  // that every method of a local-first repository really is classified as this bucket's own.
  it('keeps the local-first telemetry bucket out of the remote allow-list', () => {
    const leaked: string[] = []
    const misclassified: string[] = []
    for (const repo of LOCAL_FIRST_PERSISTENCE_REPOSITORIES) {
      for (const method of Object.keys(REMOTE_PERSISTENCE_METHODS[repo] ?? {})) {
        leaked.push(`${repo}.${method}`)
      }
      const reasons = NON_REMOTE[repo] ?? {}
      for (const method of REFLECTED[repo] ?? []) {
        // `sweeper` is legitimate here: the mothership still prunes ITS copy of the table from
        // cron, and the local store's own prune is the local retention sweep, not an RPC call.
        const reason: Reason | undefined = reasons[method]
        if (reason !== 'telemetry' && reason !== 'sweeper') {
          misclassified.push(`${repo}.${method} (${reason ?? 'unclassified'})`)
        }
      }
    }
    expect(
      leaked,
      'a LOCAL_FIRST_PERSISTENCE_REPOSITORIES repository is also in REMOTE_PERSISTENCE_METHODS — ' +
        'a mothership-mode node serves it from its own store, so the remote entry is dead surface:\n' +
        leaked.join('\n'),
    ).toEqual([])
    expect(
      misclassified,
      'every method of a local-first telemetry repository must be classified `telemetry` (served ' +
        'by the local store) or `sweeper` (the mothership-internal prune):\n' +
        misclassified.join('\n'),
    ).toEqual([])
  })

  it('never allow-lists a method also marked non-remote (no contradictory classification)', () => {
    const contradictions: string[] = []
    for (const [repo, methods] of Object.entries(REMOTE_PERSISTENCE_METHODS)) {
      const nonRemote = NON_REMOTE[repo] ?? {}
      for (const method of Object.keys(methods)) {
        if (Object.hasOwn(nonRemote, method)) {
          contradictions.push(`${repo}.${method} (${nonRemote[method]})`)
        }
      }
    }
    expect(
      contradictions,
      `these methods are BOTH allow-listed and marked non-remote — remove them from NON_REMOTE:\n${contradictions.join('\n')}`,
    ).toEqual([])
  })
})
