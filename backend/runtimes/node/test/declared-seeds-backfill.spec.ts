import { describe, expect, it, vi } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import { backfillDeclaredSeeds } from '../src/server.js'

// The boot backfill is the second of a declared seed's two wiring sites (the first is
// `WorkspaceService.create`). Pure: no database, just the container members it reads. What it pins:
// every declared seeder, the runner pool included, runs over every existing workspace, and one
// seeder failing on one workspace neither stops the others nor fails boot.

function seeder() {
  return { ensureForWorkspace: vi.fn((_workspaceId: string) => Promise.resolve()) }
}

function container(seeders: {
  environmentHandlerSeeder?: ReturnType<typeof seeder>
  sharedStackSeeder?: ReturnType<typeof seeder>
  runnerPoolSeeder?: ReturnType<typeof seeder>
}) {
  return {
    ...seeders,
    workspaceService: {
      list: vi.fn(() => Promise.resolve([{ id: 'ws-a' }, { id: 'ws-b' }])),
    },
  } as unknown as Parameters<typeof backfillDeclaredSeeds>[0]
}

describe('backfillDeclaredSeeds', () => {
  it('runs every declared seeder, the runner pool included, over every existing workspace', async () => {
    const env = seeder()
    const stacks = seeder()
    const pool = seeder()

    await backfillDeclaredSeeds(
      container({
        environmentHandlerSeeder: env,
        sharedStackSeeder: stacks,
        runnerPoolSeeder: pool,
      }),
      createRecordingLogger(),
    )

    for (const s of [env, stacks, pool]) {
      expect(s.ensureForWorkspace.mock.calls.map(([id]) => id)).toEqual(['ws-a', 'ws-b'])
    }
  })

  it('keeps going when one seeder fails on one workspace, and logs which', async () => {
    const pool = seeder()
    pool.ensureForWorkspace.mockRejectedValueOnce(new Error('pool store unreachable'))
    const env = seeder()
    const logger = createRecordingLogger()

    await backfillDeclaredSeeds(
      container({ environmentHandlerSeeder: env, runnerPoolSeeder: pool }),
      logger,
    )

    expect(env.ensureForWorkspace).toHaveBeenCalledTimes(2)
    expect(pool.ensureForWorkspace).toHaveBeenCalledTimes(2)
    const warn = logger.lines.find((l) => l.level === 'warn')
    expect(warn?.msg).toBe('runner-pool seed backfill failed for workspace')
    expect(warn?.fields).toMatchObject({ workspaceId: 'ws-a' })
  })

  it('reads no workspaces when nothing is declared', async () => {
    const c = container({})

    await backfillDeclaredSeeds(c, createRecordingLogger())

    expect(c.workspaceService.list).not.toHaveBeenCalled()
  })
})
