import {
  type AccountRepository,
  ConflictError,
  type ExecutionInstance,
  type ExecutionRepository,
  type MembershipRepository,
  type Workspace,
  type WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
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
function inProcessClient(opts: DispatchOptions): PersistenceRpcClient {
  return { call: async (request) => (await dispatchPersistenceCall(request, opts)).body }
}

const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'
const USER = 'usr_1'

function workspace(id: string, accountId: string): Workspace & { accountId: string } {
  return { id, name: id, accountId } as unknown as Workspace & { accountId: string }
}

/** A registry whose workspaces live under `ACCOUNT` (so scope binding can resolve them). */
function makeRegistry(): {
  registry: PersistenceRegistry
  resolveAccountId: DispatchOptions['resolveAccountId']
  resolveBlockAccountId: NonNullable<DispatchOptions['resolveBlockAccountId']>
  resolveBlockAccountIds: NonNullable<DispatchOptions['resolveBlockAccountIds']>
  resolveServiceAccountIds: NonNullable<DispatchOptions['resolveServiceAccountIds']>
} {
  const workspaces = new Map<string, Workspace & { accountId: string }>([
    ['ws_in', workspace('ws_in', ACCOUNT)],
    ['ws_out', workspace('ws_out', OTHER_ACCOUNT)],
  ])
  const executions = new Map<string, ExecutionInstance>()
  // Blocks home in a workspace (so a blockId resolves to that workspace's account); services are
  // account-owned (so a serviceId resolves to its account). `*_in` live under ACCOUNT, `*_out`
  // under OTHER_ACCOUNT — the in/out-of-scope split the cross-service + block rules are checked on.
  const blocks = new Map<string, { workspaceId: string }>([
    ['blk_in', { workspaceId: 'ws_in' }],
    ['blk_out', { workspaceId: 'ws_out' }],
  ])
  const services = new Map<string, { id: string; accountId: string | null }>([
    ['svc_in', { id: 'svc_in', accountId: ACCOUNT }],
    ['svc_out', { id: 'svc_out', accountId: OTHER_ACCOUNT }],
  ])

  const registry = {
    workspaceRepository: {
      get: async (id: string) => workspaces.get(id) ?? null,
      accountOf: async (id: string) =>
        workspaces.has(id) ? workspaces.get(id)!.accountId : undefined,
      // For an in-scope board: return undefined (not null) so the envelope's `undef` flag is
      // exercised — the trap is that JSON would otherwise coerce a top-level undefined to null.
      ownerOf: async (_id: string) => undefined,
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
    tokenUsageRepository: {
      totalsSinceForWorkspace: async (ws: string, _since: number) => ({ ws }),
    },
    requirementReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      deleteByBlock: async () => undefined,
    },
    clarityReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      deleteByBlock: async () => undefined,
    },
    brainstormSessionRepository: {
      getByBlockStage: async (ws: string, blockId: string, stage: string) => ({
        ws,
        blockId,
        stage,
      }),
      get: async (ws: string, id: string) => ({ ws, id }),
      upsert: async () => undefined,
      deleteByBlockStage: async () => undefined,
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
    // The fragment-source library: owner-keyed list + record-based upsert. `get` is wired but
    // sourceId-keyed (absent from the allow-list — the repo-sync management the mothership owns).
    fragmentSourceRepository: {
      listByOwner: async (ownerKind: string, ownerId: string) => [{ ownerKind, ownerId }],
      upsert: async () => undefined,
      get: async (id: string) => ({ id }),
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
  }
}

// Exercise the round-trip through the SAME full-surface registry production uses (a
// mothership-mode node builds `createRemoteRepositoryRegistry`), cast to the typed ports the
// assertions below touch.
function remote(accountIds = [ACCOUNT]) {
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

describe('persistence RPC round-trip', () => {
  it('forwards a read and returns the value', async () => {
    const repos = remote()
    const ws = await repos.workspaceRepository.get('ws_in')
    expect(ws?.id).toBe('ws_in')
  })

  it('distinguishes null from undefined on the wire', async () => {
    const repos = remote()
    // A string, a top-level undefined (must NOT coerce to null), and a null all round-trip
    // for an IN-SCOPE call. (A missing workspace can't bind scope, so it 404s — covered below.)
    await expect(repos.workspaceRepository.accountOf('ws_in')).resolves.toBe(ACCOUNT)
    await expect(repos.workspaceRepository.ownerOf('ws_in')).resolves.toBeUndefined()
    await expect(repos.executionRepository.get('ws_in', 'nope')).resolves.toBeNull()
  })

  it('refuses a call whose workspace cannot be scope-bound (missing → 404, not undefined)', async () => {
    const repos = remote()
    await expect(repos.workspaceRepository.ownerOf('ws_missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('writes a mutated rev back onto the caller object (upsert + compareAndSwap)', async () => {
    const repos = remote()
    const execution = { id: 'ex_1', rev: 4 } as unknown as ExecutionInstance
    await repos.executionRepository.upsert('ws_in', execution)
    expect(execution.rev).toBe(5)
    const ok = await repos.executionRepository.compareAndSwap('ws_in', execution)
    expect(ok).toBe(true)
    expect(execution.rev).toBe(6)
  })

  it('re-throws a DomainError with its code preserved', async () => {
    const repos = remote()
    await expect(
      repos.executionRepository.markFailed('ws_in', 'ex_1', { message: 'x' } as never),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses a method outside the allow-list', async () => {
    const repos = remote()
    // `delete` is wired on the fake repo but not in the remote allow-list.
    await expect(
      (repos.workspaceRepository as unknown as { delete(id: string): Promise<void> }).delete(
        'ws_in',
      ),
    ).rejects.toThrow(/not callable/)
  })

  it('refuses admin-gated mutations (membership/account writes) — no role escalation over RPC', async () => {
    const repos = remote([ACCOUNT])
    // `membershipRepository.upsert`/`remove` and `accountRepository.rename`/`updateSettings` are
    // admin-gated in the service layer; the RPC dispatches over the raw repo, so they MUST NOT be
    // in the allow-list (else an in-scope member could self-promote to admin). Even targeting an
    // in-scope account, they are rejected as not-callable, never reaching a repo write.
    const membership = repos.membershipRepository as unknown as {
      upsert(m: { accountId: string; userId: string; roles: string[] }): Promise<unknown>
      remove(accountId: string, userId: string): Promise<unknown>
    }
    await expect(
      membership.upsert({ accountId: ACCOUNT, userId: USER, roles: ['admin'] }),
    ).rejects.toThrow(/not callable/)
    await expect(membership.remove(ACCOUNT, USER)).rejects.toThrow(/not callable/)
    const account = repos.accountRepository as unknown as {
      rename(id: string, name: string): Promise<unknown>
      updateSettings(id: string, patch: unknown): Promise<unknown>
    }
    await expect(account.rename(ACCOUNT, 'pwned')).rejects.toThrow(/not callable/)
    await expect(account.updateSettings(ACCOUNT, {})).rejects.toThrow(/not callable/)
  })

  it('refuses prototype-chain method names without crashing (own-property allow-list)', async () => {
    const repos = remote()
    const proto = repos.workspaceRepository as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    // Index through a string variable so these hit the proxy (not the static `Object.prototype`
    // signatures). `constructor`/`toString` resolve to inherited members on a bare bracket access;
    // the dispatcher must treat them as not-callable (400), never throw an uncaught 500.
    const invoke = (method: string) => proto[method]!('ws_in')
    await expect(invoke('constructor')).rejects.toThrow(/not callable/)
    await expect(invoke('toString')).rejects.toThrow(/not callable/)
    await expect(invoke('__proto__')).rejects.toThrow(/not callable/)
  })

  it('rejects a workspace outside the token scope as not-found (no existence leak)', async () => {
    const repos = remote([ACCOUNT])
    // ws_out belongs to OTHER_ACCOUNT, which the token is not scoped to.
    await expect(repos.workspaceRepository.get('ws_out')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects an account-list read containing an out-of-scope id', async () => {
    const repos = remote([ACCOUNT])
    await expect(repos.accountRepository.listByIds([ACCOUNT, OTHER_ACCOUNT])).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    )
    // The in-scope subset alone succeeds.
    await expect(repos.accountRepository.listByIds([ACCOUNT])).resolves.toHaveLength(1)
  })
})

describe('createRemoteRepositoryRegistry (full-surface, drift-proof)', () => {
  function registryClient() {
    const { registry, ...resolvers } = makeRegistry()
    return inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds: [ACCOUNT], userId: USER },
    })
  }

  it('lazily forwards ANY accessed repository name to one RPC', async () => {
    const repos = createRemoteRepositoryRegistry(registryClient()) as unknown as {
      workspaceRepository: { get(id: string): Promise<{ id: string } | null> }
    }
    // No per-repo wiring: a repo the proxy never enumerated still resolves and forwards.
    await expect(repos.workspaceRepository.get('ws_in')).resolves.toMatchObject({ id: 'ws_in' })
  })

  it('returns the SAME proxy per repo name (cached)', () => {
    const repos = createRemoteRepositoryRegistry(registryClient()) as unknown as Record<
      string,
      unknown
    >
    expect(repos.workspaceRepository).toBe(repos.workspaceRepository)
  })

  it('still honours the server-side allow-list (un-allow-listed method → not callable)', async () => {
    const repos = createRemoteRepositoryRegistry(registryClient()) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
    // A brand-new repo name nobody allow-listed forwards to the RPC, which refuses it.
    await expect(repos.someFutureRepository!.list!('ws_in')).rejects.toThrow(/not callable/)
  })

  it('reads a non-string (symbol) access as absent, not a repository', () => {
    const repos = createRemoteRepositoryRegistry(registryClient()) as unknown as Record<
      symbol,
      unknown
    >
    // e.g. an accidental `await registry` probes `then`/Symbol.toPrimitive — must be undefined.
    expect(repos[Symbol.toPrimitive]).toBeUndefined()
  })
})

describe('board-load read surface (workspace-scoped)', () => {
  // Every newly-allow-listed read. `args` are the trailing arguments AFTER the workspaceId
  // (which the helper prepends), so the table reflects each method's real signature.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'workspaceMountRepository', method: 'listByWorkspace', args: [] },
    { repo: 'workspaceSettingsRepository', method: 'get', args: [] },
    { repo: 'riskPolicyRepository', method: 'list', args: [] },
    { repo: 'modelPresetRepository', method: 'list', args: [] },
    { repo: 'serviceFragmentDefaultsRepository', method: 'get', args: [] },
    { repo: 'pipelineScheduleRepository', method: 'list', args: [] },
    { repo: 'pipelineScheduleRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'trackerSettingsRepository', method: 'get', args: [] },
    { repo: 'notificationRepository', method: 'listOpen', args: [] },
    { repo: 'bootstrapJobRepository', method: 'listByWorkspace', args: [] },
    { repo: 'tokenUsageRepository', method: 'totalsSinceForWorkspace', args: [0] },
    { repo: 'requirementReviewRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'clarityReviewRepository', method: 'getByBlock', args: ['blk_1'] },
    {
      repo: 'brainstormSessionRepository',
      method: 'getByBlockStage',
      args: ['blk_1', 'discovery'],
    },
  ]

  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      // Each stub echoes the workspaceId, proving the call reached the bound workspace.
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses a non-allow-listed method on an allow-listed board repo', async () => {
    // `deleteByWorkspace` is wired on the fake mount repo but absent from the allow-list.
    await expect(
      remoteRegistry().workspaceMountRepository!.deleteByWorkspace!('ws_in'),
    ).rejects.toThrow(/not callable/)
  })
})

describe('cross-service + entity-id read surface (board composition)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The `serviceList`-scoped reads: arg0 is `serviceIds[]`, resolved to each service's account.
  const SERVICE_READS: Array<{ repo: string; method: string }> = [
    { repo: 'serviceRepository', method: 'listByIds' },
    { repo: 'blockRepository', method: 'listByServices' },
    { repo: 'executionRepository', method: 'listByServices' },
    { repo: 'bootstrapJobRepository', method: 'listByServices' },
    { repo: 'pipelineScheduleRepository', method: 'listByServices' },
    { repo: 'workspaceMountRepository', method: 'countByServiceIds' },
  ]

  for (const { repo, method } of SERVICE_READS) {
    it(`forwards ${repo}.${method} when every service is in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!(['svc_in'])
      expect(result).toBeDefined()
    })

    it(`rejects ${repo}.${method} when any service is out of scope (404)`, async () => {
      // svc_out belongs to OTHER_ACCOUNT; one out-of-scope id fails the whole call closed.
      await expect(remoteRegistry()[repo]![method]!(['svc_in', 'svc_out'])).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it(`rejects ${repo}.${method} for an unknown service id (fails closed)`, async () => {
      // A service that does not resolve cannot be scope-bound, so it is refused (no leak).
      await expect(remoteRegistry()[repo]![method]!(['svc_missing'])).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it(`allows ${repo}.${method} with an empty list (no service to scope)`, async () => {
      // An empty input is a no-op read; it binds no service, so it is not a scope violation.
      await expect(remoteRegistry()[repo]![method]!([])).resolves.toBeDefined()
    })
  }

  it('forwards serviceRepository.listByAccount for an in-scope account', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByAccount!(ACCOUNT),
    ).resolves.toMatchObject([{ accountId: ACCOUNT }])
  })

  it('rejects serviceRepository.listByAccount for an out-of-scope account (404)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByAccount!(OTHER_ACCOUNT),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects serviceRepository.listByAccount for the null (unscoped) listing', async () => {
    // The auth-disabled `null` org listing must never be reachable over a scoped machine token.
    await expect(remoteRegistry().serviceRepository!.listByAccount!(null)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('forwards blockRepository.findById for a block homed in an in-scope workspace', async () => {
    const found = (await remoteRegistry().blockRepository!.findById!('blk_in')) as {
      workspaceId: string
    }
    expect(found.workspaceId).toBe('ws_in')
  })

  it('rejects blockRepository.findById for a block homed out of scope (404)', async () => {
    // blk_out homes in ws_out (OTHER_ACCOUNT).
    await expect(remoteRegistry().blockRepository!.findById!('blk_out')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects blockRepository.findById for an unknown block (fails closed)', async () => {
    await expect(remoteRegistry().blockRepository!.findById!('blk_missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('agent-context run-path + lazy-seed surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The reads `AgentContextBuilder` issues for EVERY agent step (linked docs/tasks + the block's
  // provisioned environment), the run-start model-preset read, and the completion notification
  // dedup/raise — plus the workspaceId-trailing args of each. All reuse the `workspace` rule.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'modelPresetRepository', method: 'getDefault', args: [] },
    { repo: 'documentRepository', method: 'listByBlock', args: ['blk_1'] },
    { repo: 'documentRepository', method: 'get', args: ['notion', 'ext_1'] },
    { repo: 'documentRepository', method: 'getByUrl', args: ['https://example.com/spec'] },
    { repo: 'taskRepository', method: 'listByBlock', args: ['blk_1'] },
    { repo: 'taskRepository', method: 'get', args: ['jira', 'KEY-1'] },
    { repo: 'taskRepository', method: 'getByUrl', args: ['https://example.com/issue'] },
    { repo: 'environmentRegistryRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'environmentRegistryRepository', method: 'get', args: ['env_1'] },
    {
      repo: 'notificationRepository',
      method: 'findOpenByBlock',
      args: ['blk_1', 'pipeline_complete'],
    },
    { repo: 'notificationRepository', method: 'upsertOpenForBlock', args: [{ id: 'n_1' }] },
    // Block-less raises + inbox act/dismiss/escalate transitions route through `upsert`.
    { repo: 'notificationRepository', method: 'upsert', args: [{ id: 'n_1' }] },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The lazy default-preset seeds a board load triggers (`*PresetService` ensure-default writes).
  // They return void, so assert they forward in scope and are scope-rejected out of scope.
  const SEED_WRITES: Array<{ repo: string; method: string }> = [
    { repo: 'riskPolicyRepository', method: 'upsert' },
    { repo: 'modelPresetRepository', method: 'upsert' },
  ]
  for (const { repo, method } of SEED_WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('ws_in', { id: 'p_1' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', { id: 'p_1' })).rejects.toMatchObject(
        { code: 'not_found' },
      )
    })
  }
})

describe('kaizen grading read surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The reads the Kaizen screen drives (`KaizenService.getOverview` / `listForExecution`): the
  // grading history + verified-combo library + a run's per-step gradings. Each takes the
  // workspaceId as arg0 (the `workspace` rule); `args` are the trailing arguments after it.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'kaizenGradingRepository', method: 'listByWorkspace', args: [200] },
    { repo: 'kaizenGradingRepository', method: 'listByExecution', args: ['ex_1'] },
    { repo: 'kaizenVerifiedComboRepository', method: 'listByWorkspace', args: [] },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }
})

describe('settings, preset & schedule management surface (workspace-scoped writes)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The management methods a mothership-mode SPA drives to SAVE settings/presets/schedules (the
  // matching reads were already exposed for the board load). Each takes the workspaceId as arg0
  // and reuses the `workspace` rule; `args` are the trailing arguments after it. Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound
  // workspace; void writes just resolve.
  const WRITES: Array<{ repo: string; method: string; args: unknown[]; echoes?: boolean }> = [
    { repo: 'workspaceSettingsRepository', method: 'upsert', args: [{ storeAgentContext: true }] },
    { repo: 'trackerSettingsRepository', method: 'put', args: [{}] },
    { repo: 'serviceFragmentDefaultsRepository', method: 'set', args: [['frag_1']] },
    { repo: 'riskPolicyRepository', method: 'get', args: ['preset_1'], echoes: true },
    { repo: 'riskPolicyRepository', method: 'remove', args: ['preset_1'] },
    { repo: 'modelPresetRepository', method: 'get', args: ['preset_1'], echoes: true },
    { repo: 'modelPresetRepository', method: 'remove', args: ['preset_1'] },
    { repo: 'pipelineScheduleRepository', method: 'get', args: ['sched_1'], echoes: true },
    { repo: 'pipelineScheduleRepository', method: 'upsert', args: [{ id: 'sched_1' }] },
    { repo: 'pipelineScheduleRepository', method: 'remove', args: ['sched_1'] },
    { repo: 'pipelineScheduleRepository', method: 'insertRun', args: [{ id: 'run_1' }] },
    {
      repo: 'pipelineScheduleRepository',
      method: 'updateRun',
      args: ['run_1', { status: 'done' }],
    },
    { repo: 'pipelineScheduleRepository', method: 'listRuns', args: ['sched_1'], echoes: true },
  ]

  for (const { repo, method, args, echoes } of WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }
})

describe('agent-run control surface (retry/stop entry — workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // `AgentRunController` (retry/stop a run) resolves the run's KIND via `getRef(workspaceId, id)`
  // before dispatching to the matching service; it takes the workspaceId as arg0 → the `workspace`
  // rule. Exposing it makes the execution-run retry/stop path functional in mothership mode.
  it('forwards agentRunRepository.getRef for an in-scope workspace', async () => {
    const ref = await remoteRegistry().agentRunRepository!.getRef!('ws_in', 'ex_1')
    // The ref round-trips with its kind, proving the controller can branch on it over the RPC.
    expect(ref).toMatchObject({ ws: 'ws_in', id: 'ex_1', kind: 'execution' })
  })

  it('rejects agentRunRepository.getRef for an out-of-scope workspace (404, no leak)', async () => {
    // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
    await expect(
      remoteRegistry().agentRunRepository!.getRef!('ws_out', 'ex_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('still refuses the sweeper-only agentRunRepository.listStale (off the allow-list)', async () => {
    // `listStale` is wired on the fake repo but sweeper-internal — never remotely callable.
    await expect(remoteRegistry().agentRunRepository!.listStale!(0)).rejects.toThrow(/not callable/)
  })
})

describe('bootstrap / reference-arch / env-config-repair / env-test management surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The workspace-scoped reads/updates/deletes (arg0 = workspaceId → the `workspace` rule) that
  // make the bootstrap flow (start / board-card poll / retry / stop), the reference-architecture
  // library, and the env-config-repair retry/stop functional in mothership mode. Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void writes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'bootstrapJobRepository', method: 'get', args: ['boot_1'], echoes: true },
    { repo: 'bootstrapJobRepository', method: 'update', args: ['boot_1', { status: 'failed' }] },
    { repo: 'referenceArchitectureRepository', method: 'get', args: ['arch_1'], echoes: true },
    { repo: 'referenceArchitectureRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'referenceArchitectureRepository', method: 'update', args: ['arch_1', { name: 'x' }] },
    { repo: 'referenceArchitectureRepository', method: 'softDelete', args: ['arch_1', 0] },
    { repo: 'envConfigRepairJobRepository', method: 'get', args: ['repair_1'], echoes: true },
    {
      repo: 'envConfigRepairJobRepository',
      method: 'update',
      args: ['repair_1', { status: 'failed' }],
    },
    // The ephemeral-environment self-test run store: the poll/stop reads + the guarded
    // stage patches and the snapshot's in-flight-runs read, all workspaceId-arg0 scoped
    // like the repair jobs.
    { repo: 'environmentTestRunRepository', method: 'get', args: ['envtest_1'], echoes: true },
    {
      repo: 'environmentTestRunRepository',
      method: 'updateIfRunning',
      args: ['envtest_1', { stage: 'tearing_down' }],
    },
    {
      repo: 'environmentTestRunRepository',
      method: 'listRunningByWorkspace',
      args: [],
      echoes: true,
    },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `insert(record)` methods bind on the job/record's `workspaceId` FIELD (the
  // `workspaceField` rule): the row is stored under exactly `record.workspaceId`, so an
  // out-of-scope workspace in the record is refused before any repo write, and a missing/non-object
  // arg fails closed.
  const INSERTS = [
    'bootstrapJobRepository',
    'referenceArchitectureRepository',
    'envConfigRepairJobRepository',
    'environmentTestRunRepository',
  ]

  for (const repo of INSERTS) {
    it(`forwards ${repo}.insert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.insert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.insert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.insert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.insert when the record has no workspaceId field (404, fail-closed)`, async () => {
      await expect(remoteRegistry()[repo]!.insert!({})).rejects.toMatchObject({ code: 'not_found' })
    })
  }
})

describe('post-release-health settings surface (observability / release-health / incident)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The workspace-scoped reads/deletes (arg0 = workspaceId → the `workspace` rule). Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void deletes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'observabilityConnectionRepository', method: 'get', args: [], echoes: true },
    { repo: 'observabilityConnectionRepository', method: 'delete', args: [] },
    { repo: 'releaseHealthConfigRepository', method: 'getByBlock', args: ['blk_1'], echoes: true },
    { repo: 'releaseHealthConfigRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'releaseHealthConfigRepository', method: 'delete', args: ['blk_1'] },
    { repo: 'incidentEnrichmentConnectionRepository', method: 'get', args: [], echoes: true },
    { repo: 'incidentEnrichmentConnectionRepository', method: 'delete', args: [] },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `upsert(record)` methods bind on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): the write targets exactly `record.workspaceId`, so an out-of-scope
  // workspace in the record is refused before any repo write.
  const UPSERTS = [
    'observabilityConnectionRepository',
    'releaseHealthConfigRepository',
    'incidentEnrichmentConnectionRepository',
  ]

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no workspaceId field (404)`, async () => {
      // A record with no bindable workspaceId cannot be scope-checked, so it fails closed.
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    // A non-object arg (null / primitive) has no `workspaceId` to bind, so the `workspaceField`
    // rule must fail closed rather than throw on the property access or reach the repo write.
    for (const [label, arg] of [
      ['null', null],
      ['a non-string primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${repo}.upsert when the arg is ${label} (404, fail-closed)`, async () => {
        await expect(remoteRegistry()[repo]!.upsert!(arg)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    }
  }
})

describe('environment-connection management surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // Workspace-scoped reads/deletes (arg0 = workspaceId → the `workspace` rule). Value-returning
  // reads (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void deletes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'environmentConnectionRepository', method: 'listByWorkspace', args: [], echoes: true },
    {
      repo: 'environmentConnectionRepository',
      method: 'getByWorkspaceAndType',
      args: ['kubernetes', null],
      echoes: true,
    },
    {
      repo: 'environmentConnectionRepository',
      method: 'softDelete',
      args: ['kubernetes', null, 1],
    },
    { repo: 'customManifestTypeRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'customManifestTypeRepository', method: 'remove', args: ['helm-app'] },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `upsert(record)` methods bind on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): a connection / custom-type row can only ever land in an in-scope
  // workspace, and a missing/non-object arg fails closed before any repo write.
  const UPSERTS = ['environmentConnectionRepository', 'customManifestTypeRepository']

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no workspaceId field (404)`, async () => {
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    for (const [label, arg] of [
      ['null', null],
      ['a non-string primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${repo}.upsert when the arg is ${label} (404, fail-closed)`, async () => {
        await expect(remoteRegistry()[repo]!.upsert!(arg)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    }
  }
})

describe('advanced review / session management surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The clarity-review / brainstorm / consensus windows: run + re-read + persist/replace as the
  // window iterates. Every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)`
  // signature carries it positionally → the `workspace` rule). `args` are the trailing arguments
  // after it; value-returning reads (`echoed`) echo the FULL bound arg set so the round-trip can
  // assert every argument reached the repo in order, void writes resolve `undefined`.
  const METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    // The object a value-returning read echoes back (workspaceId + trailing args), asserting the
    // whole argument list survived the hop in order. Absent → a void write (resolves `undefined`).
    echoed?: Record<string, unknown>
  }> = [
    // requirement-review: getByBlock/get/upsert were exposed earlier; deleteByBlock completes it.
    {
      repo: 'requirementReviewRepository',
      method: 'get',
      args: ['rev_1'],
      echoed: { ws: 'ws_in', id: 'rev_1' },
    },
    { repo: 'requirementReviewRepository', method: 'upsert', args: [{ id: 'rev_1' }] },
    { repo: 'requirementReviewRepository', method: 'deleteByBlock', args: ['blk_1'] },
    // clarity-review (bug-report triage).
    {
      repo: 'clarityReviewRepository',
      method: 'get',
      args: ['rev_1'],
      echoed: { ws: 'ws_in', id: 'rev_1' },
    },
    { repo: 'clarityReviewRepository', method: 'upsert', args: [{ id: 'rev_1' }] },
    { repo: 'clarityReviewRepository', method: 'deleteByBlock', args: ['blk_1'] },
    // brainstorm (structured dialogue, keyed by block+stage).
    {
      repo: 'brainstormSessionRepository',
      method: 'get',
      args: ['sess_1'],
      echoed: { ws: 'ws_in', id: 'sess_1' },
    },
    { repo: 'brainstormSessionRepository', method: 'upsert', args: [{ id: 'sess_1' }] },
    {
      repo: 'brainstormSessionRepository',
      method: 'deleteByBlockStage',
      args: ['blk_1', 'discovery'],
    },
    // consensus (multi-strategy orchestration, keyed by run step).
    {
      repo: 'consensusSessionRepository',
      method: 'get',
      args: ['sess_1'],
      echoed: { ws: 'ws_in', id: 'sess_1' },
    },
    {
      repo: 'consensusSessionRepository',
      method: 'getByStep',
      args: ['ex_1', 0],
      echoed: { ws: 'ws_in', executionId: 'ex_1', stepIndex: 0 },
    },
    {
      repo: 'consensusSessionRepository',
      method: 'getByBlock',
      args: ['blk_1'],
      echoed: { ws: 'ws_in', blockId: 'blk_1' },
    },
    { repo: 'consensusSessionRepository', method: 'upsert', args: [{ id: 'sess_1' }] },
  ]

  for (const { repo, method, args, echoed } of METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoed) {
        // Assert the FULL bound arg set round-tripped (workspaceId + every trailing arg in order),
        // not just that the call was authorized — a read that dropped or reordered an arg would
        // slip past a bare `{ ws }` check.
        expect(Array.isArray(result) ? result[0] : result).toMatchObject(echoed)
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // A void write resolves `undefined`, so the loop above can't see WHAT reached the repo. Drive a
  // capturing registry to prove the write path forwards the workspaceId + payload (and, for the
  // block+stage delete, every positional key) in order across the round-trip — the write-path
  // analogue of the `echoed` reads above.
  it('forwards the workspaceId + payload to a write in order', async () => {
    const calls: unknown[][] = []
    const { registry, ...resolvers } = makeRegistry()
    const capturing: PersistenceRegistry = {
      ...registry,
      consensusSessionRepository: {
        ...registry.consensusSessionRepository,
        upsert: async (...a: unknown[]) => void calls.push(a),
      },
      brainstormSessionRepository: {
        ...registry.brainstormSessionRepository,
        deleteByBlockStage: async (...a: unknown[]) => void calls.push(a),
      },
    }
    const client = inProcessClient({
      registry: capturing,
      ...resolvers,
      scope: { accountIds: [ACCOUNT], userId: USER },
    })
    const remote = createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >

    await remote.consensusSessionRepository!.upsert!('ws_in', { id: 'sess_1' })
    await remote.brainstormSessionRepository!.deleteByBlockStage!('ws_in', 'blk_1', 'discovery')

    expect(calls).toContainEqual(['ws_in', { id: 'sess_1' }])
    expect(calls).toContainEqual(['ws_in', 'blk_1', 'discovery'])
  })
})

describe('shared-service mount management surface', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // `serviceRepository.get(serviceId)` binds via the `service` scope kind (single serviceId →
  // owning account, the single-id form of `serviceList`). svc_in lives under ACCOUNT, svc_out
  // under OTHER_ACCOUNT.
  it('forwards serviceRepository.get for an in-scope service', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_in')).resolves.toMatchObject({
      id: 'svc_in',
    })
  })

  it('rejects serviceRepository.get for an out-of-scope service (404, no leak)', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_out')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects serviceRepository.get for an unknown service (fails closed)', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects serviceRepository.get for a non-string arg (fails closed)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.get!(undefined as unknown as string),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The workspaceId-keyed mount methods (arg0 = workspaceId → the `workspace` rule): `get` echoes
  // the workspaceId, the void writes `update`/`remove` just resolve.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[]; echoes?: boolean }> = [
    { method: 'get', args: ['svc_in'], echoes: true },
    { method: 'update', args: ['svc_in', { position: { x: 1, y: 2 } }] },
    { method: 'remove', args: ['svc_in'] },
  ]

  for (const { method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards workspaceMountRepository.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().workspaceMountRepository![method]!('ws_in', ...args)
      if (echoes) expect(result).toMatchObject({ ws: 'ws_in' })
      else expect(result).toBeUndefined()
    })

    it(`rejects workspaceMountRepository.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry().workspaceMountRepository![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  // `upsert(mount)` binds on the mount's `workspaceId` FIELD via the `serviceMount` rule: the mount
  // is placed onto exactly `mount.workspaceId` (out-of-scope → refused before any write) AND the
  // mounted `serviceId` must be owned by the SAME account as that workspace (the cross-org mount
  // invariant, enforced at the RPC layer — not only in the bypassed service layer).
  it('forwards workspaceMountRepository.upsert when the mount targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_in',
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects workspaceMountRepository.upsert when the mount targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_out',
        serviceId: 'svc_in',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mount has no workspaceId field (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({ serviceId: 'svc_in' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mount has no serviceId field (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({ workspaceId: 'ws_in' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mounted service is unknown (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_missing',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The cross-org mount invariant under a MULTI-account token (a user in several orgs). Both
  // ACCOUNT and OTHER_ACCOUNT are in scope, so a workspace-only check would let one org's service
  // be mounted onto another org's board. The `serviceMount` rule's same-account requirement blocks
  // it: svc_out (OTHER_ACCOUNT) cannot be mounted onto ws_in (ACCOUNT) even though both are in scope.
  it('rejects a cross-org mount upsert even when both accounts are in the token scope (404)', async () => {
    await expect(
      remoteRegistry([ACCOUNT, OTHER_ACCOUNT]).workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_out',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forwards a same-account mount upsert for a workspace in a secondary in-scope account', async () => {
    // A multi-account token can still mount WITHIN each org: svc_out onto ws_out (both OTHER_ACCOUNT).
    await expect(
      remoteRegistry([ACCOUNT, OTHER_ACCOUNT]).workspaceMountRepository!.upsert!({
        workspaceId: 'ws_out',
        serviceId: 'svc_out',
      }),
    ).resolves.toBeUndefined()
  })

  it('still refuses a non-allow-listed mount method (real-time fan-out read)', async () => {
    // `listByService` is a mothership-internal fan-out read — absent from the allow-list.
    await expect(
      remoteRegistry().workspaceMountRepository!.listByService!('svc_in'),
    ).rejects.toThrow(/not callable/)
  })
})

describe('VCS / GitHub projection read surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The projection READS the SPA's VCS board panels display (repos/branches/PRs/issues), served
  // straight from the local projections by `GitHubService` — no GitHub API call, so they run
  // unchanged over the remote-sourced projection repos. Each takes the workspaceId as arg0 (the
  // `workspace` rule); `args` are the trailing arguments after it (a `listByRepo` also carries the
  // repoGithubId, which the scope check ignores — only the workspace binds). The installation
  // `getByWorkspace` is the run path's FIRST read (`resolveRepoTarget` resolves the installation
  // before walking the `github_repos` projection), also workspace-scoped on arg0.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'githubInstallationRepository', method: 'getByWorkspace', args: [] },
    { repo: 'repoProjectionRepository', method: 'list', args: [] },
    { repo: 'branchProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'pullRequestProjectionRepository', method: 'listByWorkspace', args: [] },
    { repo: 'issueProjectionRepository', method: 'listByWorkspace', args: [] },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      // Each stub echoes the workspaceId, proving the call reached the bound workspace.
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses the projection WRITE surface (sync ingest / board-linkage stay off)', async () => {
    // `upsertMany` (sync ingest), `setMonorepo` (board-linkage), and the single-repo
    // `get` (repo-write facade) are NOT allow-listed — the mothership owns GitHub sync + writes.
    const repos = remoteRegistry()
    await expect(repos.repoProjectionRepository!.upsertMany!('ws_in', [])).rejects.toThrow(
      /not callable/,
    )
    await expect(repos.repoProjectionRepository!.get!('ws_in', 42)).rejects.toThrow(/not callable/)
    await expect(repos.repoProjectionRepository!.setMonorepo!('ws_in', 42, true)).rejects.toThrow(
      /not callable/,
    )
    // Only `getByWorkspace` on the installation repo is opened — its installationId-keyed reads,
    // token/sync writes, the webhook fan-out, and the cron `listActive` stay off the SPA path.
    await expect(repos.githubInstallationRepository!.getByInstallationId!(42)).rejects.toThrow(
      /not callable/,
    )
    await expect(repos.githubInstallationRepository!.listActive!()).rejects.toThrow(/not callable/)
  })
})

describe('self-hosted runner-backend connection surface (workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The runner-pool settings panel's connect/rotate/disconnect (`RunnerPoolConnectionService`):
  // `getByWorkspace`/`softDelete` take the workspaceId as arg0 (the `workspace` rule); the
  // record-based `upsert(record)` binds on the record's `workspaceId` FIELD (the `workspaceField`
  // rule). The credentials ride a sealed `secretsCipher` blob, so no plaintext crosses the API.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[]; echoes?: boolean }> = [
    { method: 'getByWorkspace', args: [], echoes: true },
    { method: 'softDelete', args: [0] },
  ]

  for (const { method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards runnerPoolConnectionRepository.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().runnerPoolConnectionRepository![method]!(
        'ws_in',
        ...args,
      )
      if (echoes) expect(result).toMatchObject({ ws: 'ws_in' })
      else expect(result).toBeUndefined()
    })

    it(`rejects runnerPoolConnectionRepository.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry().runnerPoolConnectionRepository![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('forwards runnerPoolConnectionRepository.upsert when the record targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
  })

  it('rejects runnerPoolConnectionRepository.upsert when the record targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects runnerPoolConnectionRepository.upsert when the record has no workspaceId field (404)', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({}),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('binary-artifact metadata surface (visual-confirmation gate, workspace-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The artifact controllers + visual-confirmation gate reads (`ArtifactController` /
  // `HarnessArtifactController`). Point reads/deletes take the workspaceId as arg0 (the `workspace`
  // rule); `args` are the trailing arguments after it. Value-returning reads (`echoes: true`) echo
  // the workspaceId (an object or an array of one); the numeric `countByExecution` and the void
  // `delete` are asserted separately below.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[] }> = [
    { method: 'get', args: ['art_1'] },
    { method: 'listByExecution', args: ['ex_1'] },
    { method: 'listByBlock', args: ['blk_1'] },
  ]

  for (const { method, args } of WORKSPACE_METHODS) {
    it(`forwards binaryArtifactMetadataStore.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().binaryArtifactMetadataStore![method]!('ws_in', ...args)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects binaryArtifactMetadataStore.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(
        remoteRegistry().binaryArtifactMetadataStore![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('forwards binaryArtifactMetadataStore.countByExecution (numeric result) for an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.countByExecution!('ws_in', 'ex_1'),
    ).resolves.toBe(0)
  })

  it('forwards binaryArtifactMetadataStore.delete (void) for an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.delete!('ws_in', 'art_1'),
    ).resolves.toBeUndefined()
  })

  it('rejects binaryArtifactMetadataStore.delete for an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.delete!('ws_out', 'art_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The record-based `insert(record)` binds on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): a metadata row can only ever land in an in-scope workspace.
  it('forwards binaryArtifactMetadataStore.insert when the record targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.insert!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
  })

  it('rejects binaryArtifactMetadataStore.insert when the record targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.insert!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('still refuses the sweeper-only retention reads (listOlderThan off the allow-list)', async () => {
    // `listOlderThan`/`deleteOlderThan` are the retention sweep — mothership-internal, never remote.
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.listOlderThan!('ws_in', 0),
    ).rejects.toThrow(/not callable/)
  })
})

describe('service board-composition read surface (blockList-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // `serviceRepository.listByFrameBlocks(frameBlockIds)` binds via the `blockList` scope kind: arg0
  // is an array of frame BLOCK ids, each resolved to its home workspace's account server-side
  // (block → workspace → account). blk_in homes in ws_in (ACCOUNT); blk_out in ws_out
  // (OTHER_ACCOUNT). EVERY id must resolve in-scope, so a missing/out-of-scope frame fails closed.
  it('forwards listByFrameBlocks when every frame block is in scope', async () => {
    const result = (await remoteRegistry().serviceRepository!.listByFrameBlocks!([
      'blk_in',
    ])) as Array<{ frameBlockId: string }>
    expect(result[0]).toMatchObject({ frameBlockId: 'blk_in' })
  })

  it('rejects listByFrameBlocks when any frame block is out of scope (404)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByFrameBlocks!(['blk_in', 'blk_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects listByFrameBlocks for an unknown frame block (fails closed)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByFrameBlocks!(['blk_missing']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('allows listByFrameBlocks with an empty list (no block to scope)', async () => {
    await expect(remoteRegistry().serviceRepository!.listByFrameBlocks!([])).resolves.toBeDefined()
  })
})

describe('prompt-fragment library management surface (owner-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The owner-keyed reads bind on an (ownerKind, ownerId) PAIR (the `owner` rule): `workspace`
  // resolves the workspace's account, `account` IS the accountId. `args` are the trailing arguments
  // after the pair. Each is exercised with BOTH owner kinds, in and out of scope.
  const OWNER_READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'promptFragmentRepository', method: 'listByOwner', args: [] },
    { repo: 'promptFragmentRepository', method: 'get', args: ['frag_1'] },
    { repo: 'fragmentSourceRepository', method: 'listByOwner', args: [] },
  ]

  for (const { repo, method, args } of OWNER_READS) {
    it(`forwards ${repo}.${method} for a workspace owner in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!('workspace', 'ws_in', ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ownerKind: 'workspace', ownerId: 'ws_in' })
    })

    it(`forwards ${repo}.${method} for an account owner in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!('account', ACCOUNT, ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ownerKind: 'account', ownerId: ACCOUNT })
    })

    it(`rejects ${repo}.${method} for a workspace owner out of scope (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(
        remoteRegistry()[repo]![method]!('workspace', 'ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for an account owner out of scope (404, no leak)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('account', OTHER_ACCOUNT, ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for an unknown owner kind (fails closed)`, async () => {
      // A kind the rule doesn't recognise can't be scope-bound, so it is refused (never reaches the repo).
      await expect(
        remoteRegistry()[repo]![method]!('user', 'usr_x', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  // The `softDelete` (void owner-keyed write): forwards in scope, rejected out of scope.
  it('forwards promptFragmentRepository.softDelete for an in-scope owner', async () => {
    await expect(
      remoteRegistry().promptFragmentRepository!.softDelete!('account', ACCOUNT, 'frag_1', 0),
    ).resolves.toBeUndefined()
  })

  it('rejects promptFragmentRepository.softDelete for an out-of-scope owner (404)', async () => {
    await expect(
      remoteRegistry().promptFragmentRepository!.softDelete!('workspace', 'ws_out', 'frag_1', 0),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The record-based `upsert(record)` binds on the record's `(ownerKind, ownerId)` FIELDS (the
  // `ownerField` rule): a fragment/source row can only ever land under an in-scope owner.
  const UPSERTS = ['promptFragmentRepository', 'fragmentSourceRepository']

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace owner`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'workspace', ownerId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`forwards ${repo}.upsert when the record targets an in-scope account owner`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'account', ownerId: ACCOUNT }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope owner (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'workspace', ownerId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no owner fields (404, fail-closed)`, async () => {
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has an unknown owner kind (404, fail-closed)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'user', ownerId: 'usr_x' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('still refuses the sourceId-keyed sync reads (off the allow-list)', async () => {
    // `promptFragmentRepository.listBySource` + `fragmentSourceRepository.get` are the repo-sync
    // reads the mothership owns — never remotely callable from a mothership node.
    await expect(remoteRegistry().promptFragmentRepository!.listBySource!('src_1')).rejects.toThrow(
      /not callable/,
    )
    await expect(remoteRegistry().fragmentSourceRepository!.get!('src_1')).rejects.toThrow(
      /not callable/,
    )
  })
})

describe('account onboarding read surface (account-scoped)', () => {
  function remoteRegistry(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
  }

  // The two member-level account reads the SPA's account/members + email-settings panels drive.
  // arg0 is an accountId → the `account` rule (reject out-of-scope as 404). Each stub echoes the
  // accountId, proving the call reached the bound account.
  const READS: Array<{ repo: string; method: string }> = [
    { repo: 'invitationRepository', method: 'listByAccount' },
    { repo: 'emailConnectionRepository', method: 'getByAccount' },
  ]

  for (const { repo, method } of READS) {
    it(`forwards ${repo}.${method} for an in-scope account`, async () => {
      const result = await remoteRegistry()[repo]![method]!(ACCOUNT)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ accountId: ACCOUNT })
    })

    it(`rejects ${repo}.${method} for an out-of-scope account (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!(OTHER_ACCOUNT)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses the admin-gated account writes (invite create / email connect off the allow-list)', async () => {
    // `invitationRepository.create` (inviting members) and `emailConnectionRepository.upsert`
    // (connecting a provider) are admin-gated in the service layer; the RPC bypasses `requireAdmin`
    // and the token scopes accounts not roles, so they MUST stay off — never remotely callable.
    await expect(
      remoteRegistry().invitationRepository!.create!({ accountId: ACCOUNT }),
    ).rejects.toThrow(/not callable/)
    await expect(
      remoteRegistry().emailConnectionRepository!.upsert!({ accountId: ACCOUNT }),
    ).rejects.toThrow(/not callable/)
  })
})
