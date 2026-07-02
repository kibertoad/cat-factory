import { describe, expect, it } from 'vitest'
import { REMOTE_PERSISTENCE_METHODS } from '@cat-factory/server'
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
import { DrizzleCustomManifestTypeRepository } from '../src/repositories/customManifestType.js'
import {
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from '../src/repositories/fragments.js'
import { DrizzleNotificationRepository } from '../src/repositories/notifications.js'
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

// ---------------------------------------------------------------------------
// Mothership-mode allow-list completeness guard (docs/initiatives/mothership-mode.md).
//
// The behavioural `[mothership]` conformance suite proves the run-path repository methods are
// correctly proxied — but only for methods a flow actually exercises. THIS test is the
// coverage-independent backstop: it reflects EVERY public method of EVERY Drizzle repository and
// requires each to be CLASSIFIED exactly once — either it is in the server-side allow-list
// (`REMOTE_PERSISTENCE_METHODS`, i.e. remotely callable), or it is in `NON_REMOTE` with an explicit
// reason (telemetry / local-sqlite / admin-gated / sweeper / pending / helper).
//
// So adding a new Drizzle repository or method WITHOUT a deliberate decision fails this test: the
// author must either allow-list it (proxy it to the mothership) or record why it stays off the
// machine API. That is the "you forgot to proxy it" guarantee, independent of whether any
// behavioural test happens to call the new method.
// ---------------------------------------------------------------------------

type Reason =
  // Org/durable, REMOTE, but not allow-listed yet — the explicit surface-completion backlog. A
  // new org method lands here until a slice proxies it (with a scope rule + conformance coverage).
  | 'pending'
  // A per-USER credential/secret store kept on the laptop (`node:sqlite`), never the mothership.
  | 'local'
  // High-volume / local-first telemetry that must never hit the per-call RPC (writes + bulk reads).
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

// Every repository method that is NOT in the allow-list, with the reason it stays off the machine
// API. Keep in sync with the reflected surface — a NEW method missing from BOTH this map and the
// allow-list fails the partition assertion below.
const NON_REMOTE: Record<string, Record<string, Reason>> = {
  workspaceRepository: { create: 'onboarding', delete: 'sweeper' },
  accountRepository: { create: 'onboarding', rename: 'admin', updateSettings: 'admin' },
  membershipRepository: { upsert: 'admin', remove: 'admin' },
  userRepository: {
    get: 'pending',
    create: 'onboarding',
    update: 'pending',
    findByIdentity: 'pending',
    findByEmail: 'pending',
    listByIds: 'pending',
    getIdentity: 'pending',
    linkIdentity: 'onboarding',
    listIdentities: 'pending',
  },
  invitationRepository: {
    create: 'pending',
    get: 'pending',
    findByTokenHash: 'pending',
    listByAccount: 'pending',
    setStatus: 'pending',
  },
  passwordResetTokenRepository: {
    create: 'pending',
    findByTokenHash: 'pending',
    listPendingByUser: 'pending',
    setStatus: 'pending',
    consume: 'pending',
    deleteExpired: 'sweeper',
  },
  emailConnectionRepository: { getByAccount: 'pending', upsert: 'pending', softDelete: 'pending' },
  blockRepository: { listByService: 'pending' },
  pipelineRepository: {},
  executionRepository: { listByService: 'pending', listStale: 'sweeper' },
  // `getRef` is allow-listed (the board's retry/stop run-control entry point). `listStale`/
  // `liveRunIds` are the stale-run sweeper's kind-spanning reads — mothership-internal cron.
  agentRunRepository: { listStale: 'sweeper', liveRunIds: 'sweeper' },
  tokenUsageRepository: { record: 'telemetry', totalsSince: 'sweeper', deleteOlderThan: 'sweeper' },
  llmCallMetricRepository: {
    record: 'telemetry',
    latestChainTip: 'telemetry',
    listByExecution: 'pending',
    deleteOlderThan: 'sweeper',
  },
  agentContextSnapshotRepository: {
    record: 'telemetry',
    listByExecution: 'pending',
    deleteOlderThan: 'sweeper',
  },
  binaryArtifactMetadataStore: {
    insert: 'pending',
    get: 'pending',
    listByExecution: 'pending',
    countByExecution: 'pending',
    listByBlock: 'pending',
    delete: 'pending',
    listOlderThan: 'sweeper',
    deleteOlderThan: 'sweeper',
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
    get: 'pending',
    listByFrameBlocks: 'pending',
    getByRepo: 'pending',
    insert: 'pending',
    update: 'pending',
    delete: 'pending',
    deleteMany: 'pending',
  },
  workspaceMountRepository: {
    listByService: 'pending',
    listWorkspaceIdsMountingBlock: 'pending',
    get: 'pending',
    upsert: 'pending',
    update: 'pending',
    remove: 'pending',
    removeByServices: 'pending',
  },
  // The whole requirement-review repo is now remote (getByBlock/get/upsert were exposed earlier;
  // deleteByBlock — the pre-review-run drop — completes it with the advanced-review slice).
  requirementReviewRepository: {},
  kaizenGradingRepository: {
    get: 'pending',
    listByExecution: 'pending',
    listByWorkspace: 'pending',
    listPending: 'sweeper',
    claim: 'sweeper',
  },
  kaizenVerifiedComboRepository: { upsert: 'pending', listByWorkspace: 'pending' },
  // The advanced review / structured-dialogue session surfaces are now fully remote (run + re-read
  // + persist/replace as the window iterates) — get/getByStep/getByBlock/upsert for consensus,
  // get/upsert/deleteBy* for clarity + brainstorm (getByBlock/getByBlockStage were already exposed).
  consensusSessionRepository: {},
  clarityReviewRepository: {},
  brainstormSessionRepository: {},
  // `get`/`remove` are now allow-listed (the preset-library management surface); `list`/`getDefault`/
  // `upsert` were already remotely callable — so the whole merge-preset repo is remote.
  mergePresetRepository: {},
  // `upsert` is now allow-listed (the workspace-settings panel save); `get` was already remote.
  workspaceSettingsRepository: {},
  // The whole observability / incident-enrichment connection + per-block release-health config
  // surface is now allow-listed (the post-release-health settings panels' get/upsert/delete),
  // so these repos are fully remote — get/getByBlock/listByWorkspace/delete via the `workspace`
  // rule, the record-based `upsert` via the `workspaceField` rule.
  observabilityConnectionRepository: {},
  incidentEnrichmentConnectionRepository: {},
  accountSettingsRepository: { getByAccount: 'pending', upsert: 'pending', listAll: 'sweeper' },
  releaseHealthConfigRepository: {},
  provisioningLogRepository: { append: 'telemetry', list: 'pending', deleteOlderThan: 'sweeper' },
  // --- non-core repositories -----------------------------------------------------
  bootstrapJobRepository: {
    blockServiceId: 'helper',
    insert: 'pending',
    update: 'pending',
    get: 'pending',
    listByService: 'pending',
  },
  referenceArchitectureRepository: {
    insert: 'pending',
    update: 'pending',
    get: 'pending',
    listByWorkspace: 'pending',
    softDelete: 'pending',
  },
  githubInstallationRepository: {
    getByInstallationId: 'pending',
    listByInstallationIds: 'pending',
    getByWorkspace: 'pending',
    listWorkspacesForInstallation: 'pending',
    listActive: 'sweeper',
    upsert: 'pending',
    updateCachedToken: 'pending',
    softDelete: 'pending',
  },
  serviceFrameRepository: { getByFrameBlock: 'pending' },
  runnerPoolConnectionRepository: {
    getByWorkspace: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
  },
  documentRepository: { upsert: 'pending', listByWorkspace: 'pending', linkBlock: 'pending' },
  documentConnectionRepository: {
    decodeCredentials: 'helper',
    rowToRecord: 'helper',
    getByWorkspace: 'pending',
    listByWorkspace: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
  },
  envConfigRepairJobRepository: { insert: 'pending', update: 'pending', get: 'pending' },
  environmentConnectionRepository: {
    listByWorkspace: 'pending',
    getByWorkspaceAndType: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
  },
  environmentRegistryRepository: {
    insert: 'pending',
    update: 'pending',
    // listByWorkspace is now allow-listed (REMOTE_PERSISTENCE_METHODS) — the frontend UI-test
    // gate's batch env read + the environments list endpoint. Classified there, not here.
    listExpired: 'sweeper',
    softDelete: 'pending',
  },
  environmentUserHandlerRepository: {
    listByUserWorkspace: 'local',
    upsert: 'local',
    remove: 'local',
  },
  fragmentSourceRepository: {
    listByOwner: 'pending',
    get: 'pending',
    upsert: 'pending',
    updateSyncState: 'pending',
    softDelete: 'pending',
  },
  promptFragmentRepository: {
    listByOwner: 'pending',
    get: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
    listBySource: 'pending',
  },
  notificationRepository: {},
  slackConnectionRepository: {
    getByAccount: 'pending',
    getByTeam: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
  },
  slackSettingsRepository: { getByWorkspace: 'pending', upsert: 'pending' },
  slackMemberMappingRepository: { getByAccount: 'pending', upsert: 'pending' },
  taskRepository: { upsert: 'pending', listByWorkspace: 'pending', linkBlock: 'pending' },
  taskConnectionRepository: {
    decodeCredentials: 'helper',
    rowToRecord: 'helper',
    getByWorkspace: 'pending',
    listByWorkspace: 'pending',
    upsert: 'pending',
    softDelete: 'pending',
  },
  taskSourceSettingsRepository: {
    rowToRecord: 'helper',
    getByWorkspace: 'pending',
    get: 'pending',
    upsert: 'pending',
  },
  customManifestTypeRepository: {
    listByWorkspace: 'pending',
    upsert: 'pending',
    remove: 'pending',
  },
  repoProjectionRepository: {
    upsertMany: 'pending',
    list: 'pending',
    get: 'pending',
    linkedWorkspaces: 'pending',
    tombstoneMissing: 'pending',
    linkBlock: 'pending',
    setMonorepo: 'pending',
    listStale: 'sweeper',
    getCursor: 'pending',
    setCursor: 'pending',
  },
  branchProjectionRepository: { upsertMany: 'pending', listByRepo: 'pending' },
  pullRequestProjectionRepository: {
    upsertMany: 'pending',
    rowToPr: 'helper',
    listByRepo: 'pending',
    listByWorkspace: 'pending',
  },
  issueProjectionRepository: {
    upsertMany: 'pending',
    rowToIssue: 'helper',
    listByRepo: 'pending',
    listByWorkspace: 'pending',
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
    customManifestTypeRepository: DrizzleCustomManifestTypeRepository,
    fragmentSourceRepository: DrizzleFragmentSourceRepository,
    promptFragmentRepository: DrizzlePromptFragmentRepository,
    notificationRepository: DrizzleNotificationRepository,
    slackConnectionRepository: DrizzleSlackConnectionRepository,
    slackSettingsRepository: DrizzleSlackSettingsRepository,
    slackMemberMappingRepository: DrizzleSlackMemberMappingRepository,
    taskRepository: DrizzleTaskRepository,
    taskConnectionRepository: DrizzleTaskConnectionRepository,
    taskSourceSettingsRepository: DrizzleTaskSourceSettingsRepository,
    providerApiKeyRepository: DrizzleProviderApiKeyRepository,
    providerModelCatalogRepository: DrizzleProviderModelCatalogRepository,
    providerSubscriptionTokenRepository: DrizzleProviderSubscriptionTokenRepository,
    personalSubscriptionRepository: DrizzlePersonalSubscriptionRepository,
    subscriptionActivationRepository: DrizzleSubscriptionActivationRepository,
    localModelEndpointRepository: DrizzleLocalModelEndpointRepository,
    userSecretRepository: DrizzleUserSecretRepository,
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
