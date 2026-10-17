import { describe, expect, it, vi } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { DrizzleAccountRunnerPoolRepository } from '../src/repositories/containerExecution.js'
import { createApp } from '../src/server.js'
import { setupTestDb, TEST_ENV } from './harness.js'

// A declared runner pool, end to end on the stock Node facade against real Postgres. The seed is a
// callback `(account) => seed`; it lands on the ACCOUNT, boards inherit it, and a board can stop
// inheriting through an explicit marker. This is the gap the seed exists to close: on stock Node a
// runner pool is the only executor, so without it every new board starts unable to run an agent.

const SEED = {
  config: {
    kind: 'kubernetes' as const,
    kubernetes: {
      label: 'Seeded pool',
      apiServerUrl: 'https://k8s.example:6443',
      namespace: 'cat-factory',
      image: 'ghcr.io/acme/executor:1',
    },
  },
  secrets: { apiToken: 'seeded-token' },
}

const describeDb = process.env.DATABASE_URL ? describe : describe.skip

describeDb('declared account runner pool (seedAccountRunnerPool)', () => {
  async function appWith(
    seedAccountRunnerPool?: Parameters<typeof buildNodeContainer>[0]['seedAccountRunnerPool'],
  ) {
    const db = await setupTestDb()
    const container = buildNodeContainer({ db, env: TEST_ENV, seedAccountRunnerPool })
    const app = createApp(container, TEST_ENV)
    async function call<T>(method: string, path: string, body?: unknown) {
      const res = await app.fetch(
        new Request(`http://test${path}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as T) }
    }
    async function makeOrg(login: string) {
      const user = await container.userService.findOrCreateByIdentity('github', login, {
        name: login,
      })
      const org = await container.accountService.createOrg(
        { id: user.id, login, name: login },
        { name: `${login} org` },
      )
      return { userId: user.id, accountId: org.id }
    }
    const board = (accountId: string | null, ownerUserId: string | null) =>
      container.workspaceService.create({ name: 'Board', seed: false }, ownerUserId, accountId)
    const pools = new DrizzleAccountRunnerPoolRepository(db)
    // Whether the board's executor resolves to a pool, through the same resolver dispatch uses.
    const hasPool = async (snapshot: { workspace: { id: string } }) =>
      container.runners!.connectionService.hasConnection(snapshot.workspace.id)
    return { container, pools, call, makeOrg, board, hasPool }
  }

  it('seeds the account on its first board, and the board reads as configured', async () => {
    const seedSource = vi.fn(() => SEED)
    const { pools, makeOrg, board, hasPool } = await appWith(seedSource)
    const { userId, accountId } = await makeOrg('org-a')

    const snapshot = await board(accountId, userId)

    expect(await hasPool(snapshot)).toBe(true)
    expect(await pools.getByAccount(accountId)).toMatchObject({
      kind: 'kubernetes',
    })
    expect(seedSource).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }))
  })

  it('lets a second board of the same account inherit without calling the callback again', async () => {
    const seedSource = vi.fn(() => SEED)
    const { makeOrg, board, hasPool } = await appWith(seedSource)
    const { userId, accountId } = await makeOrg('org-b')
    await board(accountId, userId)

    const second = await board(accountId, userId)

    expect(await hasPool(second)).toBe(true)
    expect(seedSource).toHaveBeenCalledTimes(1)
  })

  it('seeds a personal account too', async () => {
    const { container, board, hasPool } = await appWith(() => SEED)
    const user = await container.userService.findOrCreateByIdentity('github', 'solo', {
      name: 'Solo',
    })
    const personal = await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: 'solo',
      name: 'Solo',
    })

    const snapshot = await board(personal.id, user.id)

    expect(await hasPool(snapshot)).toBe(true)
  })

  it('gives a legacy board with no account nothing', async () => {
    const { board, hasPool } = await appWith(() => SEED)

    expect(await hasPool(await board(null, null))).toBe(false)
  })

  it('leaves a board without a pool when nothing is declared', async () => {
    const { makeOrg, board, hasPool } = await appWith()
    const { userId, accountId } = await makeOrg('org-c')

    expect(await hasPool(await board(accountId, userId))).toBe(false)
  })

  it('stops inheriting once the board opts out through its settings, and resumes when it opts back in', async () => {
    const { makeOrg, board, call, container } = await appWith(() => SEED)
    const { userId, accountId } = await makeOrg('org-d')
    const id = (await board(accountId, userId)).workspace.id

    await call('PUT', `/workspaces/${id}/settings`, { inheritAccountRunnerPool: false })
    expect(await container.runners!.connectionService.hasConnection(id)).toBe(false)

    await call('PUT', `/workspaces/${id}/settings`, { inheritAccountRunnerPool: true })
    expect(await container.runners!.connectionService.hasConnection(id)).toBe(true)
  })

  it('prefers a board pool of its own, and removing it does NOT fall through unless asked to', async () => {
    const { makeOrg, board, call, container } = await appWith(() => SEED)
    const { userId, accountId } = await makeOrg('org-e')
    const id = (await board(accountId, userId)).workspace.id
    const connection = () =>
      call<{ connection: { label: string } | null }>(
        'GET',
        `/workspaces/${id}/runner-pool/connection`,
      )
    await call('POST', `/workspaces/${id}/runner-pool/connection`, {
      config: { ...SEED.config, kubernetes: { ...SEED.config.kubernetes, label: 'Board pool' } },
      secrets: { apiToken: 'board-token' },
    })
    expect((await connection()).body?.connection?.label).toBe('Board pool')

    // Deleting the board's own row, with no say on the fallback, leaves the board with NOTHING.
    await call('DELETE', `/workspaces/${id}/runner-pool/connection`)
    expect((await connection()).body?.connection).toBeNull()

    // The admin choosing the fallback gets the account's pool back.
    await call('PUT', `/workspaces/${id}/settings`, { inheritAccountRunnerPool: true })
    expect((await connection()).body?.connection?.label).toBe('Seeded pool')
    expect(await container.runners!.connectionService.hasConnection(id)).toBe(true)
  })

  it('keeps the account pool when the board is removed with fallBackToAccount=true', async () => {
    const { makeOrg, board, call } = await appWith(() => SEED)
    const { userId, accountId } = await makeOrg('org-f')
    const id = (await board(accountId, userId)).workspace.id
    await call('POST', `/workspaces/${id}/runner-pool/connection`, {
      config: { ...SEED.config, kubernetes: { ...SEED.config.kubernetes, label: 'Board pool' } },
      secrets: { apiToken: 'board-token' },
    })

    await call('DELETE', `/workspaces/${id}/runner-pool/connection?fallBackToAccount=true`)

    const got = await call<{ connection: { label: string } | null }>(
      'GET',
      `/workspaces/${id}/runner-pool/connection`,
    )
    expect(got.body?.connection?.label).toBe('Seeded pool')
  })

  it('leaves exactly one row when many boards seed the same account at once', async () => {
    const { container, pools, makeOrg } = await appWith(() => SEED)
    const { accountId } = await makeOrg('org-g')

    await Promise.all(
      Array.from({ length: 8 }, () => container.runnerPoolSeeder!.ensureForAccount(accountId)),
    )

    const rows = await pools.listByAccounts([accountId])
    expect(rows).toHaveLength(1)
  })

  it('backfills every existing account that has no pool, and leaves one holding the same seed untouched', async () => {
    const { container, pools, makeOrg } = await appWith(() => SEED)
    const a = await makeOrg('org-h')
    const b = await makeOrg('org-i')
    await container.runnerPoolSeeder!.ensureForAccount(a.accountId)
    const before = await pools.getByAccount(a.accountId)

    await container.runnerPoolSeeder!.ensureForAllAccounts()

    expect(await pools.getByAccount(b.accountId)).not.toBeNull()
    expect(await pools.getByAccount(a.accountId)).toEqual(before)
  })

  it('replaces a pool at boot once the seed is rotated, but never on board creation', async () => {
    let declared = SEED
    const { container, pools, makeOrg } = await appWith(() => declared)
    const { accountId } = await makeOrg('org-j')
    await container.runnerPoolSeeder!.ensureForAccount(accountId)
    const before = (await pools.getByAccount(accountId))!

    declared = {
      config: { ...SEED.config, kubernetes: { ...SEED.config.kubernetes, label: 'Rotated pool' } },
      secrets: { apiToken: 'rotated-token' },
    }
    await container.runnerPoolSeeder!.ensureForAccount(accountId)
    expect(await pools.getByAccount(accountId)).toEqual(before)

    await container.runnerPoolSeeder!.ensureForAllAccounts()

    const after = (await pools.getByAccount(accountId))!
    expect(after).toMatchObject({ label: 'Rotated pool', createdAt: before.createdAt })
    expect(after.secretsCipher).not.toBe(before.secretsCipher)
  })
})
