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
} {
  const workspaces = new Map<string, Workspace & { accountId: string }>([
    ['ws_in', workspace('ws_in', ACCOUNT)],
    ['ws_out', workspace('ws_out', OTHER_ACCOUNT)],
  ])
  const executions = new Map<string, ExecutionInstance>()

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
    },
    workspaceSettingsRepository: { get: async (ws: string) => ({ ws }) },
    mergePresetRepository: { list: async (ws: string) => [{ ws }] },
    modelPresetRepository: { list: async (ws: string) => [{ ws }] },
    serviceFragmentDefaultsRepository: { get: async (ws: string) => [{ ws }] },
    pipelineScheduleRepository: {
      list: async (ws: string) => [{ ws }],
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
    },
    trackerSettingsRepository: { get: async (ws: string) => ({ ws }) },
    notificationRepository: { listOpen: async (ws: string) => [{ ws }] },
    bootstrapJobRepository: { listByWorkspace: async (ws: string) => [{ ws }] },
    tokenUsageRepository: {
      totalsSinceForWorkspace: async (ws: string, _since: number) => ({ ws }),
    },
    requirementReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
    },
    clarityReviewRepository: {
      getByBlock: async (ws: string, blockId: string) => ({ ws, blockId }),
    },
    brainstormSessionRepository: {
      getByBlockStage: async (ws: string, blockId: string, stage: string) => ({
        ws,
        blockId,
        stage,
      }),
    },
  } as unknown as PersistenceRegistry

  return {
    registry,
    resolveAccountId: (id) =>
      registry.workspaceRepository!.accountOf!(id) as Promise<string | null | undefined>,
  }
}

// Exercise the round-trip through the SAME full-surface registry production uses (a
// mothership-mode node builds `createRemoteRepositoryRegistry`), cast to the typed ports the
// assertions below touch.
function remote(accountIds = [ACCOUNT]) {
  const { registry, resolveAccountId } = makeRegistry()
  const client = inProcessClient({
    registry,
    resolveAccountId,
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
    // `delete` is wired on the fake repo but not in the pilot allow-list.
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
    const { registry, resolveAccountId } = makeRegistry()
    return inProcessClient({
      registry,
      resolveAccountId,
      scope: { accountIds: [ACCOUNT], userId: USER },
    })
  }

  it('lazily forwards ANY accessed repository name to one RPC', async () => {
    const repos = createRemoteRepositoryRegistry(registryClient()) as unknown as {
      workspaceRepository: { get(id: string): Promise<{ id: string } | null> }
    }
    // No per-repo wiring: a repo the pilot proxy never enumerated still resolves and forwards.
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
    const { registry, resolveAccountId } = makeRegistry()
    const client = inProcessClient({
      registry,
      resolveAccountId,
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
