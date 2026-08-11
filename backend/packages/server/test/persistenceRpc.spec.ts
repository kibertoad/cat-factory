import { describe, expect, it } from 'vitest'
import type { ExecutionInstance } from '@cat-factory/kernel'
import { dataIntegrityFaultOf, isDataIntegrityError } from '@cat-factory/kernel'
import { createRemoteRepositoryRegistry } from '../src/persistence/remoteRepositories.js'
import { persistenceErrorToThrowable } from '../src/persistence/rpc.js'
import {
  ACCOUNT,
  inProcessClient,
  makeRegistry,
  OTHER_ACCOUNT,
  remote,
  remoteRegistry,
  UNDECODABLE_RUN_ID,
  USER,
} from './persistenceRpc.harness.js'

// The mothership-mode persistence RPC, MECHANICS half: drive the client-side remote-repository
// proxy through an in-process transport that runs the real server-side dispatcher over in-memory
// fakes — so the round-trip (scope, allow-list, undefined/null, rev write-back, DomainError) is
// exercised exactly as it will be over HTTP, with no network. The per-surface allow-list tables
// that ride the same fixtures live in `persistenceRpcSurfaces.spec.ts`.

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

  it('re-throws a DataIntegrityError as one, carrying its FAULT', async () => {
    // A mothership-mode node runs the engine with no database of its own, so the row decode that
    // recognises a poison run happens on the FAR side of this hop. Relayed as an opaque 500 it
    // arrives as a plain `Error`, `isDataIntegrityError` answers false, and the disposal that
    // breaks the immortal-run loop does nothing at all on the one deployment shape whose operator
    // cannot look at the row.
    const repos = remote()
    const thrown = await repos.executionRepository.get('ws_in', UNDECODABLE_RUN_ID).then(
      () => null,
      (error: unknown) => error,
    )
    expect(isDataIntegrityError(thrown)).toBe(true)
    // The fault is what the engine branches on, so it has to survive the hop too: without it the
    // disposal would take the reversible disposition and leave the run immortal after all.
    expect(dataIntegrityFaultOf(thrown as never)).toBe('malformed')
    // And the context, so the failure recorded on the row names the offending column.
    expect((thrown as { context?: Record<string, unknown> }).context).toMatchObject({
      table: 'agent_runs',
    })
  })

  it('reconstructs an integrity error whose fault the peer did not send as the SAFE one', async () => {
    // A node one build behind a mothership that added a fault value knows less than the thrower
    // did. `unrecognized_value` is the disposition that costs a re-drive rather than a live run.
    const rebuilt = persistenceErrorToThrowable({
      code: 'data_integrity',
      message: 'Execution row has no block_id',
    })
    expect(isDataIntegrityError(rebuilt)).toBe(true)
    expect(dataIntegrityFaultOf(rebuilt as never)).toBe('unrecognized_value')
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

describe('member-display read surface (co-membership scoped)', () => {
  function remoteUsers(accountIds = [ACCOUNT]) {
    const { registry, ...resolvers } = makeRegistry()
    const client = inProcessClient({
      registry,
      ...resolvers,
      scope: { accountIds, userId: USER },
    })
    return createRemoteRepositoryRegistry(client) as unknown as {
      userRepository: {
        get(id: string): Promise<{ id: string } | null>
        listByIds(ids: string[]): Promise<Array<{ id: string }>>
        getIdentity(provider: string, subject: string): Promise<unknown>
      }
    }
  }

  it('forwards userRepository.get for a co-member of an in-scope account', async () => {
    // usr_co is a member of ACCOUNT (in scope), so its display record is readable.
    await expect(remoteUsers().userRepository.get('usr_co')).resolves.toMatchObject({
      id: 'usr_co',
    })
    // The caller reading its OWN display record is a co-member of its own account too.
    await expect(remoteUsers().userRepository.get(USER)).resolves.toMatchObject({ id: USER })
  })

  it('rejects userRepository.get for a user only in an out-of-scope account (404)', async () => {
    // usr_out is a member of OTHER_ACCOUNT only — no existence leak, refused as not-found.
    await expect(remoteUsers().userRepository.get('usr_out')).rejects.toMatchObject({
      code: 'not_found',
    })
    // A wholly-unknown user (in no account) is likewise refused.
    await expect(remoteUsers().userRepository.get('usr_ghost')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('forwards userRepository.listByIds when every id is a co-member (roster enrichment)', async () => {
    const users = await remoteUsers().userRepository.listByIds([USER, 'usr_co'])
    expect(users).toHaveLength(2)
    // An empty roster is a no-op read (no member to scope) and still round-trips.
    await expect(remoteUsers().userRepository.listByIds([])).resolves.toHaveLength(0)
  })

  it('rejects userRepository.listByIds containing an out-of-scope id (fail closed)', async () => {
    await expect(
      remoteUsers().userRepository.listByIds(['usr_co', 'usr_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses the identity reads that carry the password secret (not in the allow-list)', async () => {
    // `getIdentity` returns `UserIdentityRecord` (with the password `secret`), so it must never be
    // remotely callable even though it is wired on the repo.
    await expect(remoteUsers().userRepository.getIdentity('password', 'a@b.co')).rejects.toThrow(
      /not callable/,
    )
  })
})

describe('per-user tutorial progress (selfUser scoped)', () => {
  const OTHER_USER = 'usr_other'

  it('forwards every method for the caller`s OWN user id', async () => {
    // The whole surface, because all three are equally reachable from a mothership-mode laptop:
    // the board-load read, the mirror write, and the user`s own "Reset progress".
    const repos = remoteRegistry([ACCOUNT], USER)
    await expect(repos.tutorialProgressRepository!.get!(USER)).resolves.toMatchObject({
      userId: USER,
    })
    await expect(
      repos.tutorialProgressRepository!.upsert!(USER, { decision: null }),
    ).resolves.toMatchObject({ userId: USER })
    await expect(repos.tutorialProgressRepository!.remove!(USER)).resolves.toMatchObject({
      userId: USER,
    })
  })

  it('refuses every method for ANOTHER user`s id (404, no existence leak)', async () => {
    // The refusal that matters: a machine token is scoped to whole ACCOUNTS, so without the
    // `selfUser` pin a node could read — or RESET — the tutorial state of anyone in the same
    // account. The write half is the sharper case, which is why it is asserted alongside the read.
    const repos = remoteRegistry([ACCOUNT], USER)
    for (const method of ['get', 'upsert', 'remove'] as const) {
      await expect(
        repos.tutorialProgressRepository![method]!(OTHER_USER, { decision: null }),
      ).rejects.toMatchObject({ code: 'not_found' })
    }
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
