import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConflictError,
  CredentialRequiredError,
  type Block,
  type Clock,
  type CreateScheduleInput,
  type ExecutionInstance,
  type PipelineSchedule,
  type Workspace,
} from '@cat-factory/kernel'
import type { ExecutionService } from '../execution/ExecutionService.js'
import { RecurringPipelineService } from './RecurringPipelineService.js'
import type { RecurringPipelineServiceDependencies } from './RecurringPipelineService.js'

// The service owns the recurring-schedule lifecycle over injected repositories + the execution
// engine. These fakes let each branch of `create`/`runNow` be asserted without a DB, focusing on
// the on-demand + run-now credential-gate behaviour.

const WS = 'ws_1'

function frame(): Block {
  return {
    id: 'blk_frame',
    title: 'Auth',
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
  }
}

function onDemandSchedule(): PipelineSchedule {
  return {
    id: 'sch_1',
    serviceId: null,
    blockId: 'blk_task',
    frameId: 'blk_frame',
    pipelineId: 'pl_1',
    template: 'custom',
    name: 'Manual pass',
    recurrence: {
      intervalHours: 24,
      weekdays: [],
      windowStartHour: null,
      windowEndHour: null,
      timezone: 'UTC',
    },
    onDemand: true,
    enabled: true,
    lastRunAt: null,
    nextRunAt: 0,
    createdAt: 0,
  }
}

/** Build the service with per-test overridable stubs; returns the service + the key spies. */
function makeService(overrides: {
  scheduleGet?: PipelineSchedule | null
  start?: () => Promise<ExecutionInstance>
}) {
  const insertRun = vi.fn(async (_ws: string, _run: { status: string }) => {})
  const upsert = vi.fn(async () => {})
  const blockInsert = vi.fn(async () => {})
  const start = vi.fn(overrides.start ?? (async () => ({ id: 'exec_1' }) as ExecutionInstance))

  const deps: RecurringPipelineServiceDependencies = {
    pipelineScheduleRepository: {
      get: async () => overrides.scheduleGet ?? null,
      upsert,
      insertRun,
      listRuns: async () => [],
    } as unknown as RecurringPipelineServiceDependencies['pipelineScheduleRepository'],
    workspaceRepository: {
      get: async () => ({ id: WS }) as Workspace,
    } as unknown as RecurringPipelineServiceDependencies['workspaceRepository'],
    pipelineRepository: {
      // A real Pipeline always carries agentKinds (schema default '[]'); the schedulable gate
      // reads it, so the mock must too.
      get: async () => ({ id: 'pl_1', agentKinds: ['coder'] }),
    } as unknown as RecurringPipelineServiceDependencies['pipelineRepository'],
    blockRepository: {
      get: async () => frame(),
      insert: blockInsert,
    } as unknown as RecurringPipelineServiceDependencies['blockRepository'],
    executionRepository: {
      getByBlock: async () => null,
    } as unknown as RecurringPipelineServiceDependencies['executionRepository'],
    executionService: {
      start,
      individualVendorsForBlock: async () => [],
    } as unknown as ExecutionService,
    idGenerator: { next: (prefix: string) => `${prefix}_x` },
    clock: { now: () => 1000 } as Clock,
  }
  return { service: new RecurringPipelineService(deps), insertRun, upsert, blockInsert, start }
}

describe('RecurringPipelineService.runNow credential gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('propagates a CredentialRequiredError from start (does NOT swallow it into a failed run)', async () => {
    const credErr = new CredentialRequiredError('Enter your personal password.', {
      vendor: 'claude',
      reason: 'wrong_password',
    })
    const { service, insertRun } = makeService({
      scheduleGet: onDemandSchedule(),
      start: async () => {
        throw credErr
      },
    })

    // The run-now controller relies on this bubbling up as a 428 so the client re-prompts;
    // swallowing it would make run-now report success while nothing ran.
    await expect(service.runNow(WS, 'sch_1', { initiatedBy: 'usr_1' })).rejects.toBe(credErr)
    // No failed history row should be recorded for a re-promptable credential condition.
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('still records a genuine start failure as a failed run (non-credential errors)', async () => {
    const { service, insertRun } = makeService({
      scheduleGet: onDemandSchedule(),
      start: async () => {
        throw new Error('container down')
      },
    })

    // A real start failure is not re-promptable: it stays swallowed into a failed history row.
    await expect(service.runNow(WS, 'sch_1', { initiatedBy: 'usr_1' })).resolves.toBeDefined()
    expect(insertRun).toHaveBeenCalledTimes(1)
    expect(insertRun.mock.calls[0]![1]).toMatchObject({ status: 'failed' })
  })
})

describe('RecurringPipelineService.create recurrence validation', () => {
  beforeEach(() => vi.clearAllMocks())

  const base: CreateScheduleInput = {
    frameId: 'blk_frame',
    pipelineId: 'pl_1',
    template: 'custom',
    name: 'Nightly',
    onDemand: false,
    enabled: true,
  } as CreateScheduleInput

  it('rejects a cadence (non-on-demand) schedule with no recurrence, before creating a block', async () => {
    const { service, blockInsert } = makeService({})
    await expect(service.create(WS, base)).rejects.toBeInstanceOf(ConflictError)
    // The precondition fires before any side effect — no orphaned block is materialised.
    expect(blockInsert).not.toHaveBeenCalled()
  })

  it('allows an on-demand schedule with no recurrence', async () => {
    const { service, blockInsert, upsert } = makeService({})
    const created = await service.create(WS, { ...base, onDemand: true })
    expect(created.onDemand).toBe(true)
    expect(blockInsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})
