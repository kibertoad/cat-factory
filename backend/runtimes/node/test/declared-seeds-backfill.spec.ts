import { describe, expect, it, vi } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import { backfillDeclaredSeeds } from '../src/server.js'

// The boot backfill is the second of a declared seed's two wiring sites (the first is
// `WorkspaceService.create`). Pure: no database, just the container members it reads. What it pins:
// the workspace-keyed seeders run over every existing workspace, the account-keyed runner pool runs
// ONCE over accounts (never per workspace), and a failure in one never stops the others or boot.

function seeder() {
  return { ensureForWorkspace: vi.fn((_workspaceId: string) => Promise.resolve()) }
}

function poolSeeder() {
  return {
    ensureForAccount: vi.fn((_accountId: string | null) => Promise.resolve()),
    ensureForAllAccounts: vi.fn(() => Promise.resolve()),
  }
}

function container(seeders: {
  environmentHandlerSeeder?: ReturnType<typeof seeder>
  sharedStackSeeder?: ReturnType<typeof seeder>
  runnerPoolSeeder?: ReturnType<typeof poolSeeder>
}) {
  return {
    ...seeders,
    workspaceService: {
      list: vi.fn(() => Promise.resolve([{ id: 'ws-a' }, { id: 'ws-b' }])),
    },
  } as unknown as Parameters<typeof backfillDeclaredSeeds>[0]
}

describe('backfillDeclaredSeeds', () => {
  it('runs the workspace seeders over every workspace and the runner pool once over accounts', async () => {
    const env = seeder()
    const stacks = seeder()
    const pool = poolSeeder()

    await backfillDeclaredSeeds(
      container({
        environmentHandlerSeeder: env,
        sharedStackSeeder: stacks,
        runnerPoolSeeder: pool,
      }),
      createRecordingLogger(),
    )

    for (const s of [env, stacks]) {
      expect(s.ensureForWorkspace.mock.calls.map(([id]) => id)).toEqual(['ws-a', 'ws-b'])
    }
    expect(pool.ensureForAllAccounts).toHaveBeenCalledTimes(1)
    expect(pool.ensureForAccount).not.toHaveBeenCalled()
  })

  it('seeds the runner pool even when no workspace-keyed seeder is declared, without listing workspaces', async () => {
    const pool = poolSeeder()
    const c = container({ runnerPoolSeeder: pool })

    await backfillDeclaredSeeds(c, createRecordingLogger())

    expect(pool.ensureForAllAccounts).toHaveBeenCalledTimes(1)
    expect(c.workspaceService.list).not.toHaveBeenCalled()
  })

  it('keeps going when one seeder fails on one workspace, and logs which', async () => {
    const env = seeder()
    env.ensureForWorkspace.mockRejectedValueOnce(new Error('handler store unreachable'))
    const stacks = seeder()
    const logger = createRecordingLogger()

    await backfillDeclaredSeeds(
      container({ environmentHandlerSeeder: env, sharedStackSeeder: stacks }),
      logger,
    )

    expect(env.ensureForWorkspace).toHaveBeenCalledTimes(2)
    expect(stacks.ensureForWorkspace).toHaveBeenCalledTimes(2)
    const warn = logger.lines.find((l) => l.level === 'warn')
    expect(warn?.msg).toBe('environment-handler seed backfill failed for workspace')
    expect(warn?.fields).toMatchObject({ workspaceId: 'ws-a' })
  })

  it('reads nothing when nothing is declared', async () => {
    const c = container({})

    await backfillDeclaredSeeds(c, createRecordingLogger())

    expect(c.workspaceService.list).not.toHaveBeenCalled()
  })
})
