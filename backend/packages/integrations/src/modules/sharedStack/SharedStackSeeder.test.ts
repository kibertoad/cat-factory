import {
  createRecordingLogger,
  type CreateSharedStackInput,
  type SharedStack,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { createSharedStackSeeder } from './SharedStackSeeder.js'

// The seeder reads only `name` off a listed stack and hands a seed straight to `create`, so the
// fake below carries just that (cast to the full entity) — these tests are about the idempotency
// and per-seed fault isolation, not the service's own creation behaviour (its own suite covers it).

function stack(name: string): SharedStack {
  return { name } as unknown as SharedStack
}

function seed(
  name: string,
  overrides: Partial<CreateSharedStackInput> = {},
): CreateSharedStackInput {
  return {
    name,
    composeFiles: [{ kind: 'inline', content: 'services:\n  db:\n    image: postgres:17\n' }],
    composeProfiles: [],
    envFiles: [],
    managedNetworks: [],
    setupSteps: [],
    prerequisites: [],
    allowHostCommands: false,
    ...overrides,
  }
}

/** A service whose `create` reflects each stack back into the list, so a second
 *  `ensureForWorkspace` re-reads it and correctly skips (the idempotency path). */
function fakeService(initial: SharedStack[] = []) {
  const stacks = [...initial]
  return {
    stacks,
    list: vi.fn((_workspaceId: string) => Promise.resolve(stacks)),
    create: vi.fn((_workspaceId: string, input: CreateSharedStackInput) => {
      const created = stack(input.name)
      stacks.push(created)
      return Promise.resolve(created)
    }),
  }
}

describe('createSharedStackSeeder', () => {
  it('creates a declared stack that is not already present', async () => {
    const service = fakeService()
    const seeder = createSharedStackSeeder({ service, seeds: [seed('shared-infra')] })

    await seeder.ensureForWorkspace('ws-1')

    expect(service.create).toHaveBeenCalledTimes(1)
    expect(service.create.mock.calls[0]![0]).toBe('ws-1')
    expect(service.create.mock.calls[0]![1]!.name).toBe('shared-infra')
  })

  it('is idempotent by NAME — a second run over the same workspace creates nothing', async () => {
    const service = fakeService()
    const seeder = createSharedStackSeeder({ service, seeds: [seed('shared-infra')] })

    await seeder.ensureForWorkspace('ws-1')
    await seeder.ensureForWorkspace('ws-1')

    expect(service.create).toHaveBeenCalledTimes(1)
  })

  it('leaves an operator-edited stack of the same name alone', async () => {
    // A seed declares "this workspace should have a stack called X", not "X must look like this" —
    // so a stack someone has since retuned is never overwritten from config on the next boot.
    const service = fakeService([stack('shared-infra')])
    const seeder = createSharedStackSeeder({ service, seeds: [seed('shared-infra')] })

    await seeder.ensureForWorkspace('ws-1')

    expect(service.create).not.toHaveBeenCalled()
  })

  it('skips a failing seed, reports it, and still creates the rest', async () => {
    const service = fakeService()
    service.create.mockImplementationOnce(() => Promise.reject(new Error('clone URL required')))
    const logger = createRecordingLogger()
    const seeder = createSharedStackSeeder({
      service,
      seeds: [seed('broken'), seed('shared-infra')],
      logger,
    })

    // Never throws: the callers are workspace creation and the boot backfill.
    await expect(seeder.ensureForWorkspace('ws-1')).resolves.toBeUndefined()

    expect(service.create).toHaveBeenCalledTimes(2)
    const warning = logger.lines.find((line) => line.level === 'warn')
    expect(warning?.msg).toContain('skipped shared stack seed')
    expect(warning?.fields).toMatchObject({ workspaceId: 'ws-1', name: 'broken' })
  })

  it('does not even read the stack store when nothing is declared', async () => {
    const service = fakeService()
    await createSharedStackSeeder({ service, seeds: [] }).ensureForWorkspace('ws-1')
    expect(service.list).not.toHaveBeenCalled()
  })
})
