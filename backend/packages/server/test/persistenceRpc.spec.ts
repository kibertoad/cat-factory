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
    // Entity-id-keyed (findById) + cross-service (listByServices) board-composition reads.
    blockRepository: {
      findById: async (blockId: string) => {
        const home = blocks.get(blockId)
        return home
          ? { workspaceId: home.workspaceId, serviceId: null, block: { id: blockId } }
          : null
      },
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
    },
    serviceRepository: {
      // Mirror the real repo: a missing id is simply absent from the result (NOT an error row).
      listByIds: async (ids: string[]) => ids.map((id) => services.get(id)).filter(Boolean),
      listByAccount: async (accountId: string) => [{ accountId }],
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
    },
    workspaceSettingsRepository: {
      get: async (ws: string) => ({ ws }),
      upsert: async () => undefined,
    },
    // `upsert` is the lazy default-seed the board-load `list` read triggers (member-level write);
    // `get`/`remove` are the preset-library editor's read-one + delete.
    mergePresetRepository: {
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
    bootstrapJobRepository: {
      listByWorkspace: async (ws: string) => [{ ws }],
      listByServices: async (ids: string[]) => ids.map((svc) => ({ svc })),
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
    { repo: 'mergePresetRepository', method: 'list', args: [] },
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
    { repo: 'mergePresetRepository', method: 'upsert' },
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
    { repo: 'mergePresetRepository', method: 'get', args: ['preset_1'], echoes: true },
    { repo: 'mergePresetRepository', method: 'remove', args: ['preset_1'] },
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
