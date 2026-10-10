import type {
  DirectoryChangeRecord,
  DirectoryChangeRepository,
  GitHubRepo,
  MembershipRepository,
  RepoProjectionRepository,
  UserRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the directory change feed (docs/initiatives/directory-sync.md). The
// feed rows are appended INSIDE each facade's repository writes, in each facade's own SQL, so the
// two things most likely to drift are exactly what a single-runtime test cannot see: which writes
// record which entities, and the per-account `seq` staying gap-free and unique when writers race.
// Every case drives the real repositories a runtime hands over and reads back through its real
// change repository.

export interface DirectoryFeedRepos {
  users: UserRepository
  memberships: MembershipRepository
  workspaces: WorkspaceRepository
  workspaceMembers: WorkspaceMemberRepository
  repos: RepoProjectionRepository
  changes: DirectoryChangeRepository
}

type Entry = [DirectoryChangeRecord['entityType'], string | null, string]

/** The entries recorded after `afterSeq`, in order, as `[type, workspaceId, entityId]`. */
async function entries(r: DirectoryFeedRepos, accountId: string, afterSeq = 0): Promise<Entry[]> {
  const rows = await r.changes.listAfter(accountId, afterSeq, 1_000)
  return rows.map((c) => [c.entityType, c.workspaceId, c.entityId])
}

export function defineDirectoryFeedSuite(name: string, makeRepos: () => DirectoryFeedRepos): void {
  describe(`[${name}] directory change feed parity`, () => {
    let n = 0
    const ids = () => {
      n += 1
      const tag = `${name}-dir-${n}-${Math.floor(Math.random() * 1e9)}`
      return { acc: `acc-${tag}`, acc2: `acc2-${tag}`, ws: `ws-${tag}`, usr: `usr-${tag}` }
    }

    async function seedUser(r: DirectoryFeedRepos, id: string): Promise<void> {
      // Null email: `users.email` is uniquely indexed where non-null, and the database is shared.
      await r.users.create({ id, name: 'Ada', email: null, avatarUrl: null, createdAt: 1_000 })
    }

    async function seedWorkspace(r: DirectoryFeedRepos, id: string, accountId: string) {
      await r.workspaces.create(
        { id, name: 'Board', description: null, createdAt: 1_000, accountId },
        null,
        accountId,
      )
    }

    const repo = (githubId: number, overrides: Partial<GitHubRepo> = {}): GitHubRepo => ({
      githubId,
      installationId: 77,
      owner: 'acme',
      name: `repo-${githubId}`,
      defaultBranch: 'main',
      private: true,
      provider: 'github',
      syncedAt: 1_000,
      ...overrides,
    })

    it('answers head 0 and an empty page for an account with no changes', async () => {
      const r = makeRepos()
      const { acc } = ids()
      expect(await r.changes.headSeq(acc)).toBe(0)
      expect(await r.changes.listAfter(acc, 0, 10)).toEqual([])
    })

    it('records an account membership with the user whose visibility it decides', async () => {
      const r = makeRepos()
      const { acc, usr } = ids()
      await seedUser(r, usr)
      await r.memberships.upsert({
        accountId: acc,
        userId: usr,
        roles: ['developer'],
        createdAt: 1,
      })
      await r.memberships.remove(acc, usr)

      expect(await entries(r, acc)).toEqual([
        ['account_membership', null, usr],
        ['user', null, usr],
        ['account_membership', null, usr],
        ['user', null, usr],
      ])
      const rows = await r.changes.listAfter(acc, 0, 10)
      expect(rows.map((c) => c.seq)).toEqual([1, 2, 3, 4])
      expect(await r.changes.headSeq(acc)).toBe(4)
    })

    it('fans a profile change out to every account the user belongs to, and only on a real update', async () => {
      const r = makeRepos()
      const { acc, acc2, usr } = ids()
      await seedUser(r, usr)
      await r.memberships.upsert({ accountId: acc, userId: usr, roles: ['admin'], createdAt: 1 })
      await r.memberships.upsert({ accountId: acc2, userId: usr, roles: ['admin'], createdAt: 1 })
      const [head, head2] = [await r.changes.headSeq(acc), await r.changes.headSeq(acc2)]

      await r.users.update(usr, {})
      await r.users.update(usr, { name: 'Ada Lovelace' })

      expect(await entries(r, acc, head)).toEqual([['user', null, usr]])
      expect(await entries(r, acc2, head2)).toEqual([['user', null, usr]])
    })

    it('records workspace and workspace-membership writes against the owning account', async () => {
      const r = makeRepos()
      const { acc, ws, usr } = ids()
      await seedUser(r, usr)
      await seedWorkspace(r, ws, acc)
      await r.workspaces.rename(ws, 'Renamed')
      await r.workspaces.setDescription(ws, 'About')
      await r.workspaces.setAccessMode(ws, 'restricted')
      await r.workspaceMembers.upsert({
        workspaceId: ws,
        userId: usr,
        role: 'member',
        createdAt: 1,
        addedByUserId: null,
      })
      await r.workspaceMembers.remove(ws, usr)

      expect(await entries(r, acc)).toEqual([
        ['workspace', ws, ws],
        ['workspace', ws, ws],
        ['workspace', ws, ws],
        ['workspace', ws, ws],
        ['workspace_membership', ws, usr],
        ['workspace_membership', ws, usr],
      ])
    })

    it('records each membership the account-revocation cascade removes, and returns its count', async () => {
      const r = makeRepos()
      const { acc, ws, usr } = ids()
      const ws2 = `${ws}-b`
      await seedUser(r, usr)
      await seedWorkspace(r, ws, acc)
      await seedWorkspace(r, ws2, acc)
      for (const workspaceId of [ws, ws2]) {
        await r.workspaceMembers.upsert({
          workspaceId,
          userId: usr,
          role: 'viewer',
          createdAt: 1,
          addedByUserId: null,
        })
      }
      const head = await r.changes.headSeq(acc)

      expect(await r.workspaceMembers.removeByAccountMembership(acc, usr)).toBe(2)
      expect(await entries(r, acc, head)).toEqual([
        ['workspace_membership', ws, usr],
        ['workspace_membership', ws2, usr],
      ])
    })

    it('records repo upserts only when what the directory publishes changed', async () => {
      const r = makeRepos()
      const { acc, ws } = ids()
      await seedWorkspace(r, ws, acc)
      const head = await r.changes.headSeq(acc)

      await r.repos.upsertMany(ws, [repo(1), repo(2)])
      // A re-sync that only moves the sync stamp is not a change anyone can observe.
      await r.repos.upsertMany(ws, [repo(1, { syncedAt: 5_000 }), repo(2, { syncedAt: 5_000 })])
      await r.repos.upsertMany(ws, [repo(1, { name: 'renamed', syncedAt: 6_000 })])
      await r.repos.setMonorepo(ws, 2, true)
      await r.repos.tombstoneMissing(ws, 77, [1], 7_000)
      // Reviving the tombstone is a change even though every field matches.
      await r.repos.upsertMany(ws, [repo(2, { syncedAt: 8_000 })])

      expect(await entries(r, acc, head)).toEqual([
        ['repo', ws, '1'],
        ['repo', ws, '2'],
        ['repo', ws, '1'],
        ['repo', ws, '2'],
        ['repo', ws, '2'],
        ['repo', ws, '2'],
      ])
    })

    it('records the whole board on delete, and keeps those rows after the cascade', async () => {
      const r = makeRepos()
      const { acc, ws, usr } = ids()
      await seedUser(r, usr)
      await seedWorkspace(r, ws, acc)
      await r.workspaceMembers.upsert({
        workspaceId: ws,
        userId: usr,
        role: 'admin',
        createdAt: 1,
        addedByUserId: null,
      })
      await r.repos.upsertMany(ws, [repo(9)])
      const head = await r.changes.headSeq(acc)

      await r.workspaces.delete(ws)

      expect(await entries(r, acc, head)).toEqual([
        ['repo', ws, '9'],
        ['workspace', ws, ws],
        ['workspace_membership', ws, usr],
      ])
      expect(await r.changes.headSeq(acc)).toBe(head + 3)
    })

    it('records the board tree in both accounts when it moves between them', async () => {
      const r = makeRepos()
      const { acc, acc2, ws } = ids()
      await seedWorkspace(r, ws, acc)
      await r.repos.upsertMany(ws, [repo(3)])
      const head = await r.changes.headSeq(acc)

      await r.workspaces.linkAccount(ws, acc2)

      expect(await entries(r, acc, head)).toEqual([
        ['repo', ws, '3'],
        ['workspace', ws, ws],
      ])
      expect(await entries(r, acc2)).toEqual([
        ['repo', ws, '3'],
        ['workspace', ws, ws],
      ])
    })

    it('hands out a gap-free, duplicate-free sequence to concurrent writers', async () => {
      // The ordering guarantee is a property of RACING writers: a sequential test passes on a
      // `MAX(seq) + 1` with no lock, which then hands two transactions the same number.
      const r = makeRepos()
      const { acc, usr } = ids()
      const users = Array.from({ length: 8 }, (_, i) => `${usr}-${i}`)
      for (const id of users) await seedUser(r, id)

      await Promise.all(
        users.map((userId) =>
          r.memberships.upsert({ accountId: acc, userId, roles: ['developer'], createdAt: 1 }),
        ),
      )

      const rows = await r.changes.listAfter(acc, 0, 100)
      expect(rows.map((c) => c.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    })

    it('pages strictly after the cursor', async () => {
      const r = makeRepos()
      const { acc, ws } = ids()
      await seedWorkspace(r, ws, acc)
      for (const name of ['a', 'b', 'c']) await r.workspaces.rename(ws, name)

      const first = await r.changes.listAfter(acc, 0, 2)
      const second = await r.changes.listAfter(acc, first.at(-1)?.seq ?? 0, 2)
      expect(first.map((c) => c.seq)).toEqual([1, 2])
      expect(second.map((c) => c.seq)).toEqual([3, 4])
      expect(second[0]).toMatchObject({ accountId: acc, entityType: 'workspace', workspaceId: ws })
    })
  })
}
