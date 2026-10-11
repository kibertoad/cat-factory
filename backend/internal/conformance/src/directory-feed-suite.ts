import type {
  DirectoryChangeRecord,
  DirectoryRepository,
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
  changes: DirectoryRepository
}

type Entry = [DirectoryChangeRecord['entityType'], string | null, string]

/** The entries recorded after `afterSeq`, in order, as `[type, workspaceId, entityId]`. */
async function entries(r: DirectoryFeedRepos, accountId: string, afterSeq = 0): Promise<Entry[]> {
  const rows = await r.changes.listChanges(
    accountId,
    afterSeq,
    Number.MAX_SAFE_INTEGER,
    1_000,
    null,
  )
  return rows.map((c) => [c.entityType, c.workspaceId, c.entityId])
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

export function defineDirectoryFeedSuite(name: string, makeRepos: () => DirectoryFeedRepos): void {
  describe(`[${name}] directory change feed parity`, () => {
    let n = 0
    const ids = () => {
      n += 1
      const tag = `${name}-dir-${n}-${Math.floor(Math.random() * 1e9)}`
      return { acc: `acc-${tag}`, acc2: `acc2-${tag}`, ws: `ws-${tag}`, usr: `usr-${tag}` }
    }

    it('answers head 0 and an empty page for an account with no changes', async () => {
      const r = makeRepos()
      const { acc } = ids()
      expect(await r.changes.headSeq(acc)).toBe(0)
      expect(await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 10, null)).toEqual([])
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
      const rows = await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 10, null)
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

    it('serves a reach the deletion of a board its grant went with, and nothing else of it', async () => {
      const r = makeRepos()
      const { acc, ws, usr } = ids()
      const kept = `${ws}-kept`
      await seedUser(r, usr)
      await seedWorkspace(r, ws, acc)
      await seedWorkspace(r, kept, acc)
      await r.workspaceMembers.upsert({
        workspaceId: ws,
        userId: usr,
        role: 'admin',
        createdAt: 1,
        addedByUserId: null,
      })
      const head = await r.changes.headSeq(acc)

      await r.workspaces.delete(ws)

      // Deleting the board drops a key's grant on it, so the reach no longer names it. The
      // workspace deletion still reaches the key; the membership row, which names a user, does not.
      for (const reach of [[kept], []]) {
        const rows = await r.changes.listChanges(acc, head, Number.MAX_SAFE_INTEGER, 100, reach)
        expect(rows.map((c) => [c.entityType, c.workspaceId, c.entityId])).toEqual([
          ['workspace', ws, ws],
        ])
      }
      // A board that still exists outside the reach stays invisible.
      expect(
        await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 100, [ws]),
      ).not.toContainEqual(expect.objectContaining({ entityId: kept }))
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

      const rows = await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 100, null)
      expect(rows.map((c) => c.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    })

    it('pages strictly after the cursor', async () => {
      const r = makeRepos()
      const { acc, ws } = ids()
      await seedWorkspace(r, ws, acc)
      for (const name of ['a', 'b', 'c']) await r.workspaces.rename(ws, name)

      const first = await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 2, null)
      const second = await r.changes.listChanges(
        acc,
        first.at(-1)?.seq ?? 0,
        Number.MAX_SAFE_INTEGER,
        2,
        null,
      )
      expect(first.map((c) => c.seq)).toEqual([1, 2])
      expect(second.map((c) => c.seq)).toEqual([3, 4])
      expect(second[0]).toMatchObject({ accountId: acc, entityType: 'workspace', workspaceId: ws })
    })

    it('serves keyset snapshot pages of every entity, bounded to the account and the reach', async () => {
      const r = makeRepos()
      const { acc, acc2, ws, usr } = ids()
      const ws2 = `${ws}-b`
      const foreign = `${ws}-foreign`
      for (const id of [usr, `${usr}-2`]) {
        await seedUser(r, id)
        await r.memberships.upsert({
          accountId: acc,
          userId: id,
          roles: ['developer'],
          createdAt: 5,
        })
      }
      await seedWorkspace(r, ws, acc)
      await seedWorkspace(r, ws2, acc)
      await seedWorkspace(r, foreign, acc2)
      for (const workspaceId of [ws, ws2, foreign]) {
        await r.workspaceMembers.upsert({
          workspaceId,
          userId: usr,
          role: 'member',
          createdAt: 6,
          addedByUserId: null,
        })
        await r.repos.upsertMany(workspaceId, [repo(1), repo(2)])
      }
      await r.repos.tombstoneMissing(ws2, 77, [1], 9_000)

      const all = await r.changes.listWorkspaces(acc, null, 10, null)
      expect(all.map((w) => w.id)).toEqual([ws, ws2])
      expect(all[0]).toEqual({ id: ws, name: 'Board', description: null, accessMode: 'account' })
      const page1 = await r.changes.listWorkspaces(acc, null, 1, null)
      const page2 = await r.changes.listWorkspaces(acc, page1[0]!.id, 1, null)
      expect([...page1, ...page2].map((w) => w.id)).toEqual([ws, ws2])
      expect((await r.changes.listWorkspaces(acc, null, 10, [ws2])).map((w) => w.id)).toEqual([ws2])

      expect((await r.changes.listUsers(acc, null, 10)).map((u) => u.id)).toEqual(
        [usr, `${usr}-2`].sort(),
      )
      expect(await r.changes.listAccountMemberships(acc, usr, 10)).toEqual([
        { userId: `${usr}-2`, roles: ['developer'], createdAt: 5 },
      ])

      const members = await r.changes.listWorkspaceMemberships(acc, null, 10, null)
      expect(members).toEqual([
        { workspaceId: ws, userId: usr, role: 'member', createdAt: 6 },
        { workspaceId: ws2, userId: usr, role: 'member', createdAt: 6 },
      ])
      expect(
        await r.changes.listWorkspaceMemberships(acc, { workspaceId: ws, userId: usr }, 10, null),
      ).toEqual([members[1]])

      // The tombstoned repo is gone from the snapshot; the other account's are never there.
      const repos = await r.changes.listRepos(acc, null, 10, null)
      expect(repos.map((x) => [x.workspaceId, x.repoId])).toEqual([
        [ws, 1],
        [ws, 2],
        [ws2, 1],
      ])
      expect(repos[0]).toEqual({
        workspaceId: ws,
        repoId: 1,
        provider: 'github',
        owner: 'acme',
        name: 'repo-1',
        defaultBranch: 'main',
        private: true,
        monorepo: false,
      })
      expect(
        (await r.changes.listRepos(acc, { workspaceId: ws, repoId: 1 }, 10, [ws])).map(
          (x) => x.repoId,
        ),
      ).toEqual([2])
    })

    it('hydrates by key, answering an absent entity and another account’s alike', async () => {
      const r = makeRepos()
      const { acc, acc2, ws, usr } = ids()
      await seedUser(r, usr)
      await r.memberships.upsert({ accountId: acc, userId: usr, roles: ['admin'], createdAt: 1 })
      await seedWorkspace(r, ws, acc)
      await r.workspaceMembers.upsert({
        workspaceId: ws,
        userId: usr,
        role: 'admin',
        createdAt: 2,
        addedByUserId: null,
      })
      await r.repos.upsertMany(ws, [repo(4)])

      expect((await r.changes.getWorkspaces(acc, [ws, 'ws_missing'])).map((w) => w.id)).toEqual([
        ws,
      ])
      expect(await r.changes.getWorkspaces(acc2, [ws])).toEqual([])
      expect((await r.changes.getUsers(acc, [usr])).map((u) => u.id)).toEqual([usr])
      // A user is part of an account's directory only while they hold a membership in it.
      expect(await r.changes.getUsers(acc2, [usr])).toEqual([])
      expect(await r.changes.getAccountMemberships(acc, [usr])).toEqual([
        { userId: usr, roles: ['admin'], createdAt: 1 },
      ])
      expect(
        await r.changes.getWorkspaceMemberships(acc, [
          { workspaceId: ws, userId: usr },
          { workspaceId: ws, userId: 'usr_missing' },
        ]),
      ).toEqual([{ workspaceId: ws, userId: usr, role: 'admin', createdAt: 2 }])
      expect(
        (await r.changes.getRepos(acc, [{ workspaceId: ws, repoId: 4 }])).map((x) => x.repoId),
      ).toEqual([4])
      await r.repos.tombstoneMissing(ws, 77, [], 5_000)
      expect(await r.changes.getRepos(acc, [{ workspaceId: ws, repoId: 4 }])).toEqual([])
    })

    it('filters the feed to a reach, and prunes old rows but never an account’s newest', async () => {
      const r = makeRepos()
      const { acc, ws, usr } = ids()
      await seedUser(r, usr)
      await r.memberships.upsert({ accountId: acc, userId: usr, roles: ['admin'], createdAt: 1 })
      await seedWorkspace(r, ws, acc)
      await seedWorkspace(r, `${ws}-b`, acc)

      // A reach sees its workspaces' entities only, never users or account memberships.
      const reached = await r.changes.listChanges(acc, 0, Number.MAX_SAFE_INTEGER, 100, [ws])
      expect(reached.map((c) => [c.entityType, c.workspaceId])).toEqual([['workspace', ws]])
      const head = await r.changes.headSeq(acc)
      expect(await r.changes.listChanges(acc, 0, 2, 100, null)).toHaveLength(2)

      // Every row is older than the cutoff; only the newest survives, so `seq` keeps counting.
      await r.changes.pruneChanges(Number.MAX_SAFE_INTEGER)
      expect(await r.changes.oldestSeq(acc)).toBe(head)
      expect(await r.changes.headSeq(acc)).toBe(head)
      await r.workspaces.rename(ws, 'after prune')
      expect(await r.changes.headSeq(acc)).toBe(head + 1)
    })
  })
}
