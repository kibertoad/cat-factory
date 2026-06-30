import { ConflictError, type ExecutionInstance, type Workspace } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  createRemoteRepositories,
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
  } as unknown as PersistenceRegistry

  return {
    registry,
    resolveAccountId: (id) =>
      registry.workspaceRepository!.accountOf!(id) as Promise<string | null | undefined>,
  }
}

function remote(accountIds = [ACCOUNT]) {
  const { registry, resolveAccountId } = makeRegistry()
  const client = inProcessClient({
    registry,
    resolveAccountId,
    scope: { accountIds, userId: USER },
  })
  return createRemoteRepositories(client)
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
