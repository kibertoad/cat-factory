import type {
  AccountRecord,
  AccountRepository,
  AccountRunnerPoolRecord,
  AccountRunnerPoolRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the ACCOUNT tier of the runner pool, and for the account enumeration a
// declared seed's boot backfill reads.
//
// What can differ per store, and so is asserted on every one: the insert-if-absent arbiter (the
// primary key on `account_id`, reached through `ON CONFLICT DO NOTHING` on both), whether it reports
// truthfully that THIS call inserted, and whether concurrent writers leave one row. A sequential
// test passes on a store that read-then-inserts; the concurrent case is the one that catches it.
// `replace` is the reseed's write: it must overwrite in place, keep `createdAt`, and never insert.

/** The two repositories the suite drives, over the runtime's real store. */
export interface AccountRunnerPoolSuiteRepos {
  pools: AccountRunnerPoolRepository
  accounts: AccountRepository
}

export function defineAccountRunnerPoolSuite(
  name: string,
  makeRepos: () => AccountRunnerPoolSuiteRepos,
): void {
  describe(`[${name}] account runner pool parity`, () => {
    let seq = 0
    const nextId = () => {
      seq += 1
      return `acc-pool-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    const row = (accountId: string, label = 'Pool'): AccountRunnerPoolRecord => ({
      accountId,
      kind: 'kubernetes',
      providerId: 'k8s',
      label,
      baseUrl: 'https://k8s.example:6443',
      configJson: '{"kind":"kubernetes"}',
      secretsCipher: 'sealed',
      createdAt: 1_000,
    })

    it('answers null for an account with no pool', async () => {
      const { pools } = makeRepos()

      expect(await pools.getByAccount(nextId())).toBeNull()
    })

    it('inserts a pool, reports that it did, and reads it back unchanged', async () => {
      const { pools } = makeRepos()
      const id = nextId()

      expect(await pools.insertIfAbsent(row(id))).toBe(true)

      expect(await pools.getByAccount(id)).toEqual(row(id))
    })

    it('leaves an existing pool untouched and reports that it inserted nothing', async () => {
      const { pools } = makeRepos()
      const id = nextId()
      await pools.insertIfAbsent(row(id, 'First'))

      expect(await pools.insertIfAbsent(row(id, 'Second'))).toBe(false)

      expect((await pools.getByAccount(id))?.label).toBe('First')
    })

    it('leaves ONE row and ONE winner when many writers insert the same account at once', async () => {
      const { pools } = makeRepos()
      const id = nextId()

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => pools.insertIfAbsent(row(id, `Writer ${i}`))),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await pools.listByAccounts([id])).toHaveLength(1)
    })

    it('replaces an existing pool in place, keeping when it was first created', async () => {
      const { pools } = makeRepos()
      const id = nextId()
      await pools.insertIfAbsent(row(id, 'First'))

      const changed = { ...row(id, 'Second'), configJson: '{"kind":"manifest"}', createdAt: 9_999 }
      expect(await pools.replace(changed)).toBe(true)

      expect(await pools.getByAccount(id)).toEqual({ ...changed, createdAt: 1_000 })
      expect(await pools.listByAccounts([id])).toHaveLength(1)
    })

    it('never inserts through replace, and reports that it replaced nothing', async () => {
      const { pools } = makeRepos()
      const id = nextId()

      expect(await pools.replace(row(id))).toBe(false)

      expect(await pools.getByAccount(id)).toBeNull()
    })

    it('lists the pools of the named accounts in one call, omitting accounts without one', async () => {
      const { pools } = makeRepos()
      const [a, b, none] = [nextId(), nextId(), nextId()]
      await pools.insertIfAbsent(row(a))
      await pools.insertIfAbsent(row(b))

      const found = await pools.listByAccounts([a, b, none])

      expect(found.map((r) => r.accountId).sort()).toEqual([a, b].sort())
    })

    it('answers an empty list for an empty request', async () => {
      const { pools } = makeRepos()

      expect(await pools.listByAccounts([])).toEqual([])
    })

    it('enumerates every account, personal and org alike', async () => {
      const { accounts } = makeRepos()
      const org: AccountRecord = {
        id: nextId(),
        type: 'org',
        name: 'Org',
        githubAccountLogin: null,
        ownerUserId: null,
        createdAt: 1_000,
      }
      await accounts.create(org)

      const all = await accounts.listAll()

      expect(all.map((a) => a.id)).toContain(org.id)
    })
  })
}
