import { describe, expect, it, vi } from 'vitest'
import { createRecordingLogger, type RunnerBackendConfig } from '@cat-factory/kernel'
import { createRunnerPoolSeeder, type RunnerPoolSeed } from './RunnerPoolSeeder.js'

// The seeder only asks whether the workspace has a pool and hands the seed to `register`, so the
// fake below is just those two calls. Registration itself (validation, secrets, the stored record)
// is the connection service's, covered by its own suite.

const seed: RunnerPoolSeed = {
  config: { kind: 'manifest' } as unknown as RunnerBackendConfig,
  secrets: { token: 'seed-token' },
}

/** A connection service whose `register` makes the workspace report a pool from then on. */
function fakeConnectionService(registered: string[] = []) {
  const pools = new Set(registered)
  return {
    hasConnection: vi.fn((workspaceId: string) => Promise.resolve(pools.has(workspaceId))),
    register: vi.fn((workspaceId: string) => {
      pools.add(workspaceId)
      return Promise.resolve({} as never)
    }),
  }
}

describe('createRunnerPoolSeeder', () => {
  it('registers the seed on a workspace that has no runner pool', async () => {
    const cs = fakeConnectionService()
    const seeder = createRunnerPoolSeeder({ connectionService: cs, seed })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.register).toHaveBeenCalledWith('ws-1', seed)
  })

  it('never replaces a pool the workspace already has, so an admin choice wins', async () => {
    const cs = fakeConnectionService(['ws-1'])
    const seeder = createRunnerPoolSeeder({ connectionService: cs, seed })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.register).not.toHaveBeenCalled()
  })

  it('is idempotent: a second pass over the same workspace registers nothing', async () => {
    const cs = fakeConnectionService()
    const seeder = createRunnerPoolSeeder({ connectionService: cs, seed })

    await seeder.ensureForWorkspace('ws-1')
    await seeder.ensureForWorkspace('ws-1')

    expect(cs.register).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a seed, not even the presence read', async () => {
    const cs = fakeConnectionService()
    const seeder = createRunnerPoolSeeder({ connectionService: cs, seed: undefined })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.hasConnection).not.toHaveBeenCalled()
    expect(cs.register).not.toHaveBeenCalled()
  })

  it('logs and swallows a failed registration, so creation and boot never fail on a seed', async () => {
    const cs = fakeConnectionService()
    cs.register.mockRejectedValueOnce(new Error('Missing secret values for: token'))
    const logger = createRecordingLogger()
    const seeder = createRunnerPoolSeeder({ connectionService: cs, seed, logger })

    await expect(seeder.ensureForWorkspace('ws-1')).resolves.toBeUndefined()

    const warn = logger.lines.find((l) => l.level === 'warn')
    expect(warn?.msg).toBe('skipped runner pool seed (registration failed)')
    expect(warn?.fields).toMatchObject({ workspaceId: 'ws-1', kind: 'manifest' })
  })
})
