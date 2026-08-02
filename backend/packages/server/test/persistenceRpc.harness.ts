// Shared fixtures for the mothership-mode persistence-RPC specs: an in-process transport that
// runs the REAL server-side dispatcher over in-memory fakes, plus the registry those fakes make
// up. Extracted from `persistenceRpc.spec.ts` when the surface tables outgrew one file — the spec
// files below it assert; this module only builds the world they assert against.
//
// `remoteRegistry` is the untyped, name-indexed client every per-surface table drives (each table
// only needs "call `repo.method(...)` and see what comes back"); `remote` is the typed projection
// the round-trip mechanics assert against.

import {
  type AccountRepository,
  ConflictError,
  type ExecutionInstance,
  type ExecutionRepository,
  type MembershipRepository,
  type Workspace,
  type WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  createRemoteRepositoryRegistry,
  type PersistenceRpcClient,
} from '../src/persistence/remoteRepositories.js'
import {
  type DispatchOptions,
  type PersistenceRegistry,
  dispatchPersistenceCall,
} from '../src/persistence/rpc.js'

// The mothership-mode persistence RPC: drive the client-side remote-repository proxy through
// an in-process transport that runs the real server-side dispatcher over in-memory fakes —
// so the round-trip (scope, allow-list, undefined/null, rev write-back, DomainError) is
// exercised exactly as it will be over HTTP, with no network.

/** A transport that runs the dispatcher in-process (the controller minus HTTP). */
export function inProcessClient(opts: DispatchOptions): PersistenceRpcClient {
  return { call: async (request) => (await dispatchPersistenceCall(request, opts)).body }
}

export const ACCOUNT = 'acc_1'
export const OTHER_ACCOUNT = 'acc_2'
export const USER = 'usr_1'

function workspace(id: string, accountId: string): Workspace & { accountId: string } {
  return { id, name: id, accountId } as unknown as Workspace & { accountId: string }
}

/**
 * The in-memory world every repository fake reads: the two boards (one in scope, one not), the
 * blocks that home in them, the account-owned services, the account rosters, and the executions
 * a write actually lands in. Shared by the four builders below so a call routed through one
 * surface is visible to the resolvers on another — exactly as one store would be.
 */
interface RegistryFixtures {
  workspaces: Map<string, Workspace & { accountId: string }>
  executions: Map<string, ExecutionInstance>
  blocks: Map<string, { workspaceId: string }>
  services: Map<string, { id: string; accountId: string | null }>
  accountMembers: Map<string, string[]>
}

function makeFixtures(): RegistryFixtures {
  return {
    workspaces: new Map([
      ['ws_in', workspace('ws_in', ACCOUNT)],
      ['ws_out', workspace('ws_out', OTHER_ACCOUNT)],
    ]),
    executions: new Map(),
    // Blocks home in a workspace (so a blockId resolves to that workspace's account); services are
    // account-owned (so a serviceId resolves to its account). `*_in` live under ACCOUNT, `*_out`
    // under OTHER_ACCOUNT — the in/out-of-scope split the cross-service + block rules are checked on.
    blocks: new Map([
      ['blk_in', { workspaceId: 'ws_in' }],
      ['blk_out', { workspaceId: 'ws_out' }],
    ]),
    services: new Map([
      ['svc_in', { id: 'svc_in', accountId: ACCOUNT }],
      ['svc_out', { id: 'svc_out', accountId: OTHER_ACCOUNT }],
    ]),
    // Account rosters, for the member-display scope (`user`/`userList`): USER + a co-member live
    // under ACCOUNT; a distinct user lives under OTHER_ACCOUNT — the in/out-of-scope split the
    // display reads are checked on (a co-member is visible; a user only in another account is
    // refused).
    accountMembers: new Map([
      [ACCOUNT, [USER, 'usr_co']],
      [OTHER_ACCOUNT, ['usr_out']],
    ]),
  }
}

/**
 * The repositories whose reads RESOLVE a call's scope — the boards, runs, blocks, services and the
 * account/membership/user graph the dispatcher binds every other surface against.
 */
function buildScopeAnchorRepos(fx: RegistryFixtures) {
  const { workspaces, executions, blocks, services, accountMembers } = fx
  return {
    workspaceRepository: {
      get: async (id: string) => workspaces.get(id) ?? null,
      accountOf: async (id: string) =>
        workspaces.has(id) ? workspaces.get(id)!.accountId : undefined,
      // For an in-scope board: return undefined (not null) so the envelope's `undef` flag is
      // exercised — the trap is that JSON would otherwise coerce a top-level undefined to null.
      ownerOf: async (_id: string) => undefined,
      // The account-tier installation fallback's batched boards read (`account` scope).
      listByAccount: async (accountId: string) => [{ id: 'ws_in', accountId }],
      // Not in the allow-list — must be refused even though it's wired.
      delete: async (id: string) => void workspaces.delete(id),
    },
    executionRepository: {
      // Mimic the optimistic-concurrency contract: bump the row's rev in place on write.
      upsert: async (_workspaceId: string, execution: ExecutionInstance) => {
        execution.rev = (execution.rev ?? 0) + 1
        executions.set(execution.id, { ...execution })
      },
      compareAndSwap: async (_workspaceId: string, execution: ExecutionInstance) => {
        execution.rev = (execution.rev ?? 0) + 1
        executions.set(execution.id, { ...execution })
        return true
      },
      get: async (_workspaceId: string, id: string) => executions.get(id) ?? null,
      // Always conflicts — to prove a DomainError survives the hop.
      markFailed: async () => {
        throw new ConflictError('already terminal', 'invalid_state' as never)
      },
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
      // The remote debugging surface's run index — echoes the bound workspace like every other
      // workspace-scoped list stub below.
      listRecent: async (workspaceId: string) => [{ ws: workspaceId }],
      // The per-run debug lists' 404 guard probe. The stub echoes the workspace so the READS
      // table can prove the call reached it (the real method returns a boolean).
      exists: async (workspaceId: string) => ({ ws: workspaceId }),
      // Run admission control's capacity read (workspace-scoped SQL COUNT → a number).
      countActiveByWorkspace: async (_ws: string) => 2,
    },
    // Entity-id-keyed (findById/findByIds) + cross-service (listByServices) board-composition reads.
    blockRepository: {
      findById: async (blockId: string) => {
        const home = blocks.get(blockId)
        return home
          ? { workspaceId: home.workspaceId, serviceId: null, block: { id: blockId } }
          : null
      },
      // The batched form (the `blockList` scope's resolver reads this): a missing block is simply
      // absent from the result, so the `blockList` rule fails closed on it. Shape mirrors the real
      // repo: `Array<{ workspaceId, block: { id } }>`.
      findByIds: async (ids: string[]) =>
        ids
          .map((id) => {
            const home = blocks.get(id)
            return home ? { workspaceId: home.workspaceId, block: { id } } : null
          })
          .filter(Boolean),
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
      // The public API's in-flight cap (workspace-scoped SQL COUNT → a number).
      countActiveInternal: async (_ws: string) => 3,
      // The container-resize child translation: a workspace-scoped arithmetic UPDATE returning
      // nothing. The stub echoes its arguments so the test can prove they arrived intact — a
      // silently dropped `dx`/`dy` would leave a mothership-mode board's contents behind.
      shiftChildPositions: async (
        workspaceId: string,
        parentId: string,
        dx: number,
        dy: number,
      ) => ({
        ws: workspaceId,
        parentId,
        dx,
        dy,
      }),
    },
    serviceRepository: {
      // Mirror the real repo: a missing id is simply absent from the result (NOT an error row).
      listByIds: async (ids: string[]) => ids.map((id) => services.get(id)).filter(Boolean),
      listByAccount: async (accountId: string) => [{ accountId }],
      // The single-service read behind the org-catalog mount flow (`service` scope kind).
      get: async (id: string) => services.get(id) ?? null,
      // The batched board-composition read keyed on frame BLOCK ids (`blockList` scope): echoes
      // each frame block id so the round-trip can assert the call reached the bound blocks.
      listByFrameBlocks: async (frameBlockIds: string[]) =>
        frameBlockIds.map((frameBlockId) => ({ frameBlockId })),
    },
    accountRepository: {
      get: async (id: string) => ({ id, name: id }),
      listByIds: async (ids: string[]) => ids.map((id) => ({ id, name: id })),
    },
    // The account roster read, which the `resolveAccountMemberIds` scope resolver maps to userIds
    // (the `user`/`userList` scope). `upsert`/`remove` are wired but admin-gated (absent from the
    // allow-list), so they must be refused as not-callable.
    membershipRepository: {
      listByAccount: async (accountId: string) =>
        (accountMembers.get(accountId) ?? []).map((userId) => ({ accountId, userId, roles: [] })),
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    // The member-display reads: `get`/`listByIds` echo the requested id(s) as a presentational
    // `UserRecord`. The identity/auth reads (`getIdentity`/`listIdentities`) are wired but absent
    // from the allow-list (they carry the password secret), so they must be refused.
    userRepository: {
      get: async (id: string) => ({ id, name: id, email: null, avatarUrl: null, createdAt: 0 }),
      listByIds: async (ids: string[]) =>
        ids.map((id) => ({ id, name: id, email: null, avatarUrl: null, createdAt: 0 })),
      getIdentity: async () => null,
    },
  }
}

/** The workspace-scoped board-load surface: settings, presets, schedules, notifications, envs. */
function buildBoardConfigRepos() {
  return {
    // The workspace-scoped board-load read surface. Each stub echoes its workspaceId so the
    // round-trip can assert the call reached the bound workspace; `deleteByWorkspace` is wired
    // but absent from the allow-list, to prove a non-listed method on a listed repo is refused.
    workspaceMountRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      deleteByWorkspace: async (_ws: string) => undefined,
      countByServiceIds: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 1])),
      // The shared-service mount management surface: `get`/`update`/`remove` echo the workspaceId
      // (arg0); the record-based `upsert` binds on the mount's `workspaceId` FIELD.
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      update: async () => undefined,
      remove: async () => undefined,
      // The real-time fan-out's per-publish read: origin workspaceId (arg0) + a blockId.
      listWorkspaceIdsMountingBlock: async (ws: string, blockId: string) => [`${ws}:${blockId}`],
    },
    workspaceSettingsRepository: {
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
    },
    // `upsert` is the lazy default-seed the board-load `list` read triggers (member-level write);
    // `get`/`remove` are the preset-library editor's read-one + delete.
    riskPolicyRepository: {
      list: async (ws: string) => [{ ws }],
      getDefault: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      get: async (ws: string) => ({ ws }),
      remove: async () => undefined,
    },
    modelPresetRepository: {
      list: async (ws: string) => [{ ws }],
      getDefault: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      get: async (ws: string) => ({ ws }),
      remove: async () => undefined,
    },
    // Per-workspace agent system-prompt overrides. `head` is on the RUN path (every dispatch
    // resolves the live revision), the other three serve the pipeline builder's prompt editor.
    agentPromptRepository: {
      listRevisions: async (ws: string) => [{ ws }],
      listRevisionsByKinds: async (ws: string) => [{ ws }],
      listHeads: async (ws: string) => [{ ws }],
      head: async (ws: string) => ({ ws }),
      append: async () => undefined,
    },
    // Per-agent-kind generation settings (the output-token ceiling). `get` is on the RUN path
    // (every dispatch resolves the dispatched kind's ceiling); `list` serves the builder.
    workspaceAgentSettingsRepository: {
      get: async (ws: string) => ({ ws }),
      list: async (ws: string) => [{ ws }],
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    // The agent-context run-path reads: a block's linked docs/tasks + provisioned environment.
    documentRepository: {
      listByBlock: async (ws: string) => [{ ws }],
      get: async (ws: string) => ({ ws }),
      getByUrl: async (ws: string) => ({ ws }),
    },
    taskRepository: {
      listByBlock: async (ws: string) => [{ ws }],
      get: async (ws: string) => ({ ws }),
      getByUrl: async (ws: string) => ({ ws }),
    },
    environmentRegistryRepository: {
      getByBlock: async (ws: string) => ({ ws }),
      get: async (ws: string) => ({ ws }),
    },
    // The environment-connection management surface: workspace-scoped reads/deletes echo their
    // workspaceId (arg0); the record-based `upsert` binds on the record's `workspaceId` FIELD.
    environmentConnectionRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      getByWorkspaceAndType: async (
        ws: string,
        provisionType: string,
        manifestId: string | null,
      ) => ({
        ws,
        provisionType,
        manifestId,
      }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
    },
    // The custom-manifest-type catalog (no secrets): reads/removes echo their workspaceId (arg0);
    // the record-based `upsert` binds on the record's `workspaceId` FIELD.
    customManifestTypeRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    // The workspace's outbound webhook endpoint. `get`/`delete` echo their workspaceId (arg0);
    // the record-based `put` binds on the record's `workspaceId` FIELD. The signing secret comes
    // back SEALED, so nothing decrypted crosses the machine API.
    notificationWebhookRepository: {
      get: async (ws: string) => ({ ws }),
      put: async () => undefined,
      delete: async () => undefined,
    },
    serviceFragmentDefaultsRepository: {
      get: async (ws: string) => [{ ws }],
      set: async () => undefined,
    },
    pipelineScheduleRepository: {
      list: async (ws: string) => [{ ws }],
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      remove: async () => undefined,
      insertRun: async () => undefined,
      updateRun: async () => undefined,
      listRuns: async (ws: string) => [{ ws }],
    },
    trackerSettingsRepository: {
      get: async (ws: string) => ({ ws }),
      put: async () => undefined,
    },
    notificationRepository: {
      listOpen: async (ws: string) => [{ ws }],
      findOpenByBlock: async (ws: string) => ({ ws }),
      findOpenByType: async (ws: string) => ({ ws }),
      upsertOpenForBlock: async (ws: string) => ({ ws }),
      upsert: async (ws: string) => ({ ws }),
    },
    // The repo-bootstrap management / retry / stop surface: reads/updates echo the workspaceId
    // (arg0); the record-based `insert` binds on the job's `workspaceId` FIELD.
    bootstrapJobRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
      get: async (ws: string, id: string) => ({ ws, id }),
      insert: async () => undefined,
      update: async () => undefined,
    },
    // The reference-architecture library (bootstrap modal CRUD + retry re-resolve): reads/updates/
    // deletes echo the workspaceId (arg0); the record-based `insert` binds on the record's field.
    referenceArchitectureRepository: {
      get: async (ws: string, id: string) => ({ ws, id }),
      listByWorkspace: async (ws: string) => [{ ws }],
      insert: async () => undefined,
      update: async () => undefined,
      softDelete: async () => undefined,
    },
    // The env-config-repair retry/stop surface: reads/updates echo the workspaceId (arg0); the
    // record-based `insert` binds on the job's `workspaceId` FIELD.
    envConfigRepairJobRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      get: async (ws: string, id: string) => ({ ws, id }),
      insert: async () => undefined,
      update: async () => undefined,
    },
    // The ephemeral-environment self-test run store (start / durable poll / stop + the
    // snapshot's in-flight read): reads/patches echo the workspaceId (arg0); the record-based
    // `insert` binds on the run's `workspaceId` FIELD. The write is the guarded
    // `updateIfRunning` (first-writer-wins vs the stop button); the stub returns undefined
    // like the other write stubs — this suite pins scope routing, not return payloads.
    environmentTestRunRepository: {
      get: async (ws: string, id: string) => ({ ws, id }),
      listRunningByWorkspace: async (ws: string) => [{ ws }],
      insert: async () => undefined,
      updateIfRunning: async () => undefined,
    },
    // The board's run-control entry (retry/stop): resolve a run's kind by (workspaceId, id). The
    // stub echoes the workspaceId; `listStale` is wired but sweeper-only (absent from the allow-list).
    agentRunRepository: {
      getRef: async (ws: string, id: string) => ({ ws, id, kind: 'execution' }),
      listStale: async () => [],
    },
    // The spend ledger. `record(row)` is the one telemetry-shaped WRITE that is remote (the budget
    // gate reads its rollups remotely, so a laptop-local ledger would under-enforce); it echoes the
    // row so an accepted call proves which one reached the store.
    tokenUsageRepository: {
      totalsSinceForWorkspace: async (ws: string, _since: number) => ({ ws }),
      record: async (row: unknown) => row,
    },
  }
}

/** The review / session / integration-connection surfaces (each admin-gated on its own permission). */
function buildReviewAndIntegrationRepos() {
  return {
    // Only the non-secret config read is routable; `getByAccount` (which would carry the sealed
    // secret blob) deliberately is not, so the fake offers both and the surface table proves
    // which one the allow-list actually forwards.
    accountSettingsRepository: {
      getConfigByAccount: async (accountId: string) => ({ accountId, allowInitiatorPat: false }),
      getByAccount: async (accountId: string) => ({ accountId, secretsCipher: 'sealed' }),
      upsert: async () => undefined,
      listAll: async () => [],
    },
    requirementReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      compareAndSwap: async () => undefined,
      replaceForBlock: async () => undefined,
    },
    clarityReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      compareAndSwap: async () => undefined,
      replaceForBlock: async () => undefined,
    },
    brainstormSessionRepository: {
      getByBlockStage: async (ws: string, blockId: string, stage: string) => ({
        ws,
        blockId,
        stage,
      }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      compareAndSwap: async () => undefined,
      replaceForBlockStage: async () => undefined,
    },
    consensusSessionRepository: {
      get: async (ws: string, id: string) => ({ ws, id }),
      getByStep: async (ws: string, executionId: string, stepIndex: number) => ({
        ws,
        executionId,
        stepIndex,
      }),
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      upsert: async () => undefined,
    },
    consensusGroupRepository: {
      list: async (ws: string) => [{ ws }],
      listByIds: async (ws: string, ids: string[]) => [{ ws, ids }],
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      remove: async () => undefined,
    },
    // The post-release-health settings surface: reads/deletes echo their workspaceId (arg0);
    // the record-based `upsert` binds on the record's `workspaceId` FIELD.
    observabilityConnectionRepository: {
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      delete: async () => undefined,
    },
    releaseHealthConfigRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      listByWorkspace: async (ws: string) => [{ ws }],
      upsert: async () => undefined,
      delete: async () => undefined,
    },
    incidentEnrichmentConnectionRepository: {
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      delete: async () => undefined,
    },
    // The Kaizen screen read surface: grading history + per-run status + the verified-combo
    // library. Each echoes its workspaceId (arg0); the run-path `getByStep`/`upsert` +
    // combo `getByKey` were exposed earlier.
    kaizenGradingRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      listByExecution: async (ws: string, executionId: string) => [{ ws, executionId }],
    },
    kaizenVerifiedComboRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
    },
    // The VCS/GitHub projection READ surface the SPA's board panels display (repos/branches/
    // PRs/issues). Each echoes its workspaceId (arg0); `list` is also on the run-path repo
    // resolution. The projection WRITES + per-repo `listByRepo` variants stay off (a later slice).
    // `githubInstallationRepository.getByWorkspace` is the run path's FIRST read (before `list`);
    // it echoes the workspaceId as a single record. The rest of the installation repo stays off.
    githubInstallationRepository: {
      getByWorkspace: async (ws: string) => ({ ws }),
      // The account-scoped installation list the repo-sourced libraries resolve their GitHub
      // credential through; echoes the accountId (arg0). `listActive` is its GLOBAL sibling —
      // wired but absent from the allow-list, so it must be refused.
      listActiveForAccount: async (accountId: string) => [{ accountId }],
      listActive: async () => [],
    },
    repoProjectionRepository: {
      list: async (ws: string) => [{ ws }],
    },
    branchProjectionRepository: {
      listByRepo: async (ws: string) => [{ ws }],
    },
    pullRequestProjectionRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
    },
    issueProjectionRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
    },
    // The self-hosted runner-backend connection surface: `getByWorkspace`/`softDelete` echo the
    // workspaceId (arg0); the record-based `upsert` binds on the record's `workspaceId` FIELD.
    runnerPoolConnectionRepository: {
      getByWorkspace: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
    },
    // The binary-artifact METADATA surface (visual-confirmation gate). Point reads echo the
    // workspaceId (arg0); the record-based `insert` binds on the record's `workspaceId` FIELD; the
    // void `delete` resolves. `listOlderThan` is wired but sweeper-only (absent from the allow-list).
    binaryArtifactMetadataStore: {
      get: async (ws: string) => ({ ws }),
      listByExecution: async (ws: string) => [{ ws }],
      countByExecution: async (_ws: string) => 0,
      listByBlock: async (ws: string) => [{ ws }],
      insert: async () => undefined,
      delete: async () => undefined,
      listOlderThan: async () => [],
    },
  }
}

/**
 * The account-owned skill sources the `skillSource` scope rule resolves against: one under each
 * account, plus (by absence) `sklsrc_missing`, which resolves to nothing and must fail closed.
 */
const SKILL_SOURCES = new Map<string, { id: string; accountId: string }>([
  ['sklsrc_in', { id: 'sklsrc_in', accountId: ACCOUNT }],
  ['sklsrc_out', { id: 'sklsrc_out', accountId: OTHER_ACCOUNT }],
])

/** The owner-scoped content library (fragments, sources) plus the invitation / Slack / telemetry reads. */
function buildLibraryAndCommsRepos() {
  return {
    // The prompt-fragment library management surface, keyed by an (ownerKind, ownerId) PAIR. Each
    // read echoes the pair so the round-trip can assert the whole bound owner reached the repo;
    // the void writes resolve. `listBySource` is wired but sourceId-keyed (absent from the allow-list).
    promptFragmentRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      get: async (ownerKind: string, ownerId: string, fragmentId: string) => ({
        ownerKind,
        ownerId,
        fragmentId,
      }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
      listBySource: async () => [],
    },
    // The generated-brief store: owner-keyed list + record-based upsert + owner-keyed delete.
    // Same (ownerKind, ownerId) pair as the fragments it condenses, so the same rules bind it.
    fragmentBriefRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      upsert: async () => undefined,
      delete: async () => undefined,
    },
    // The fragment-source library: owner-keyed list + record-based upsert. `get` is wired but
    // sourceId-keyed (absent from the allow-list — the repo-sync management the mothership owns).
    fragmentSourceRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      upsert: async () => undefined,
      get: async (id: string) => ({ id }),
    },
    // The repo-sourced Claude Skills library (ADR 0024). ONE tier — the account — so the reads
    // echo the accountId (arg0) and the sourceId-keyed sync methods bind through the `skillSource`
    // rule (source → owning account, resolved server-side from `skillSourceRepository.get`).
    // `sklsrc_in` lives under ACCOUNT, `sklsrc_out` under OTHER_ACCOUNT (see `SKILL_SOURCES`), so
    // the same in/out-of-scope split the block/service rules use applies here.
    accountSkillRepository: {
      listByAccount: async (accountId: string) => [{ accountId }],
      get: async (accountId: string, skillId: string) => ({ accountId, skillId }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
      listBySource: async (sourceId: string) => [{ sourceId }],
      softDeleteBySource: async () => undefined,
    },
    skillSourceRepository: {
      listByAccount: async (accountId: string) => [{ accountId }],
      get: async (id: string) => SKILL_SOURCES.get(id) ?? null,
      upsert: async () => undefined,
      updateSyncState: async () => undefined,
      softDelete: async () => undefined,
      // Wired but deliberately OFF the allow-list: the GLOBAL push-webhook reverse lookup, which
      // spans every account by construction and runs on the mothership. Must be refused.
      listByRepo: async (repoOwner: string, repoName: string) => [{ repoOwner, repoName }],
    },
    // The foundational-services catalog + its contract documents — the same (ownerKind, ownerId)
    // pair as the fragment library, so the same `owner` / `ownerField` rules bind them. The reads
    // echo the pair; the void writes resolve. `listBySource`/`softDeleteBySource` and the source
    // repo's `listByRepo` are wired but unscoped by construction (absent from the allow-list).
    foundationalServiceRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      get: async (ownerKind: string, ownerId: string, serviceId: string) => ({
        ownerKind,
        ownerId,
        serviceId,
      }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
      hardDelete: async () => undefined,
      listBySource: async () => [],
      softDeleteBySource: async () => undefined,
    },
    apiContractRepository: {
      listManifestByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      listByServiceIds: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      replaceForService: async () => undefined,
      deleteForService: async () => undefined,
    },
    foundationalServiceSourceRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      upsert: async () => undefined,
      listByRepo: async () => [],
    },
    // The account onboarding reads: each echoes the accountId (arg0) so the round-trip can assert
    // the call reached the bound account. `create` is wired but admin-gated (absent from the allow-list).
    invitationRepository: {
      listByAccount: async (accountId: string) => [{ accountId }],
      create: async () => undefined,
    },
    emailConnectionRepository: {
      getByAccount: async (accountId: string) => ({ accountId }),
      upsert: async () => undefined,
    },
    // The Slack management surface. `slackConnectionRepository` is per-account: `getByAccount`/
    // `softDelete` echo the accountId (arg0); the record-based `upsert` binds on the record's
    // `accountId` FIELD (the new `accountField` rule). `getByTeam` is wired but absent from the
    // allow-list (the global inbound-OAuth teamId lookup, mothership-internal), so it must be refused.
    slackConnectionRepository: {
      getByAccount: async (accountId: string) => ({ accountId }),
      upsert: async () => undefined,
      softDelete: async () => undefined,
      getByTeam: async (teamId: string) => ({ teamId }),
    },
    // Per-workspace routing (no secrets): `getByWorkspace` echoes the workspaceId (arg0); the
    // record-based `upsert` binds on the record's `workspaceId` FIELD.
    slackSettingsRepository: {
      getByWorkspace: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
    },
    // Per-account member mapping (no secrets): both methods take the accountId as arg0 positionally.
    slackMemberMappingRepository: {
      getByAccount: async (accountId: string) => [{ accountId }],
      upsert: async () => undefined,
    },
    // Wired but deliberately OFF the allow-list now that telemetry is local-first: a
    // mothership-mode node summarises its OWN local store, and the mothership's copy holds none
    // of that node's calls, so a remote summarize could only ever report zeros.
    llmCallMetricRepository: {
      summarizeByExecution: async () => [],
    },
  }
}

/** A registry whose workspaces live under `ACCOUNT` (so scope binding can resolve them). */
export function makeRegistry(): {
  registry: PersistenceRegistry
  resolveAccountId: DispatchOptions['resolveAccountId']
  resolveBlockAccountId: NonNullable<DispatchOptions['resolveBlockAccountId']>
  resolveBlockAccountIds: NonNullable<DispatchOptions['resolveBlockAccountIds']>
  resolveServiceAccountIds: NonNullable<DispatchOptions['resolveServiceAccountIds']>
  resolveSkillSourceAccountId: NonNullable<DispatchOptions['resolveSkillSourceAccountId']>
  resolveAccountMemberIds: NonNullable<DispatchOptions['resolveAccountMemberIds']>
} {
  const fx = makeFixtures()
  const registry = {
    ...buildScopeAnchorRepos(fx),
    ...buildBoardConfigRepos(),
    ...buildReviewAndIntegrationRepos(),
    ...buildLibraryAndCommsRepos(),
  } as unknown as PersistenceRegistry

  const resolveAccountId = (id: string) =>
    registry.workspaceRepository!.accountOf!(id) as Promise<string | null | undefined>
  return {
    registry,
    resolveAccountId,
    // Built exactly as the controller builds them, so the round-trip exercises the real
    // server-side resolution shape (block → home workspace → account; serviceId → account).
    resolveBlockAccountId: async (blockId) => {
      const found = (await registry.blockRepository!.findById!(blockId)) as {
        workspaceId?: string
      } | null
      const ws = found?.workspaceId
      return typeof ws === 'string' ? resolveAccountId(ws) : undefined
    },
    // The batched form (the `blockList` scope): one `findByIds` resolves every frame block's home
    // workspace, then each workspace's account. A block absent from the read is absent from the map,
    // so the rule fails closed on it.
    resolveBlockAccountIds: async (blockIds) => {
      const found = (await registry.blockRepository!.findByIds!(blockIds)) as Array<{
        workspaceId: string
        block: { id: string }
      }>
      const map = new Map<string, string | null | undefined>()
      for (const entry of found) map.set(entry.block.id, await resolveAccountId(entry.workspaceId))
      return map
    },
    resolveServiceAccountIds: async (ids) => {
      const services = (await registry.serviceRepository!.listByIds!(ids)) as Array<{
        id: string
        accountId: string | null
      }>
      const map = new Map<string, string | null | undefined>()
      for (const service of services) map.set(service.id, service.accountId)
      return map
    },
    // Built exactly as the controller builds it (source row → its `accountId`), so the round-trip
    // exercises the real server-side resolution for the `skillSource` scope. A source that does not
    // exist yields undefined, which the rule fails closed on.
    resolveSkillSourceAccountId: async (sourceId) => {
      const source = (await registry.skillSourceRepository!.get!(sourceId)) as {
        accountId?: string
      } | null
      return source?.accountId
    },
    // Built exactly as the controller builds it (roster → userIds), so the round-trip exercises the
    // real server-side co-membership resolution for the `user`/`userList` scope.
    resolveAccountMemberIds: async (accountId) => {
      const memberships = (await registry.membershipRepository!.listByAccount!(
        accountId,
      )) as Array<{
        userId: string
      }>
      return memberships.map((m) => m.userId)
    },
  }
}

// Exercise the round-trip through the SAME full-surface registry production uses (a
// mothership-mode node builds `createRemoteRepositoryRegistry`), cast to the typed ports the
// assertions below touch.
export function remote(accountIds = [ACCOUNT]) {
  const { registry, ...resolvers } = makeRegistry()
  const client = inProcessClient({
    registry,
    ...resolvers,
    scope: { accountIds, userId: USER },
  })
  return createRemoteRepositoryRegistry(client) as unknown as {
    workspaceRepository: WorkspaceRepository
    executionRepository: ExecutionRepository
    accountRepository: AccountRepository
    membershipRepository: MembershipRepository
  }
}

/**
 * The client-side proxy as a bare `repository -> method -> call` index. Every per-surface scope
 * table drives this shape: it asserts on WHICH calls are forwarded/refused, not on the typed
 * port, so naming each repository's interface would only obscure the table.
 */
export function remoteRegistry(accountIds = [ACCOUNT], userId = USER) {
  const { registry, ...resolvers } = makeRegistry()
  const client = inProcessClient({ registry, ...resolvers, scope: { accountIds, userId } })
  return createRemoteRepositoryRegistry(client) as unknown as Record<
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>>
  >
}
