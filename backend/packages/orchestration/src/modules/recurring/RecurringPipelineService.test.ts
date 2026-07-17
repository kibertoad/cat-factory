import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConflictError,
  CredentialRequiredError,
  ValidationError,
  type Block,
  type Clock,
  type CreateScheduleInput,
  type ExecutionInstance,
  type Pipeline,
  type PipelineSchedule,
  type Workspace,
} from '@cat-factory/kernel'
import type { TaskConnectionService } from '@cat-factory/integrations'
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
  priorRun?: ExecutionInstance | null
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
      getByBlock: async () => overrides.priorRun ?? null,
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

describe('RecurringPipelineService active-run overlap guard', () => {
  beforeEach(() => vi.clearAllMocks())

  // F10 (stuck-run audit): a prior run parked `blocked` on a human gate (a review / decision)
  // is STILL live — firing the next pass over it would orphan its durable driver against a
  // replaced execution, so a later human resolve hits NotFound. `blocked` must be treated the
  // same as `running`/`paused` by the overlap guard.
  for (const status of ['running', 'paused', 'blocked'] as const) {
    it(`refuses a run-now (force) fire when the prior run is ${status}`, async () => {
      const { service, start } = makeService({
        scheduleGet: onDemandSchedule(),
        priorRun: { id: 'exec_prior', status } as ExecutionInstance,
      })
      await expect(service.runNow(WS, 'sch_1', { initiatedBy: 'usr_1' })).rejects.toBeInstanceOf(
        ConflictError,
      )
      // The guard fires BEFORE start(), so the parked run is never replaced.
      expect(start).not.toHaveBeenCalled()
    })
  }

  it('allows a run-now fire when the prior run is terminal (done)', async () => {
    const { service, start } = makeService({
      scheduleGet: onDemandSchedule(),
      priorRun: { id: 'exec_prior', status: 'done' } as ExecutionInstance,
    })
    await service.runNow(WS, 'sch_1', { initiatedBy: 'usr_1' })
    expect(start).toHaveBeenCalledTimes(1)
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

// Phase E intake-config validation: a `bug-intake` pipeline's schedule must carry an
// `issueIntake` config pointed at an OFFERED (available + enabled) task source. Guards both the
// missing-config case and — via `isOffered`, not the default-true `isEnabled` — a source that is
// not actually connected.
describe('RecurringPipelineService bug-intake intake-config validation', () => {
  beforeEach(() => vi.clearAllMocks())

  const RECURRENCE = {
    intervalHours: 24,
    weekdays: [],
    windowStartHour: null,
    windowEndHour: null,
    timezone: 'UTC',
  }
  const bugIntakePipeline = {
    id: 'pl_1',
    agentKinds: ['bug-intake', 'architect'],
    availability: 'recurring',
    enabled: [true, true],
  } as unknown as Pipeline

  function makeIntakeService(offered: boolean | undefined) {
    const upsert = vi.fn(async () => {})
    const blockInsert = vi.fn(async () => {})
    const deps: RecurringPipelineServiceDependencies = {
      pipelineScheduleRepository: {
        get: async () => null,
        upsert,
        insertRun: async () => {},
        listRuns: async () => [],
      } as unknown as RecurringPipelineServiceDependencies['pipelineScheduleRepository'],
      workspaceRepository: {
        get: async () => ({ id: WS }) as Workspace,
      } as unknown as RecurringPipelineServiceDependencies['workspaceRepository'],
      pipelineRepository: {
        get: async () => bugIntakePipeline,
      } as unknown as RecurringPipelineServiceDependencies['pipelineRepository'],
      blockRepository: {
        get: async () => frame(),
        insert: blockInsert,
      } as unknown as RecurringPipelineServiceDependencies['blockRepository'],
      executionRepository: {
        getByBlock: async () => null,
      } as unknown as RecurringPipelineServiceDependencies['executionRepository'],
      executionService: {
        start: vi.fn(async () => ({ id: 'exec_1' }) as ExecutionInstance),
        individualVendorsForBlock: async () => [],
      } as unknown as ExecutionService,
      idGenerator: { next: (prefix: string) => `${prefix}_x` },
      clock: { now: () => 1000 } as Clock,
      // Absent when `offered === undefined` (no task sources wired ⇒ only the presence check runs).
      ...(offered === undefined
        ? {}
        : {
            taskConnectionService: {
              isOffered: async () => offered,
            } as unknown as TaskConnectionService,
          }),
    }
    return { service: new RecurringPipelineService(deps), upsert, blockInsert }
  }

  const withIntake = (issueIntake?: unknown) =>
    ({
      frameId: 'blk_frame',
      pipelineId: 'pl_1',
      template: 'custom',
      name: 'Nightly',
      onDemand: false,
      enabled: true,
      recurrence: RECURRENCE,
      ...(issueIntake ? { issueIntake } : {}),
    }) as CreateScheduleInput

  it('rejects a bug-intake schedule with no issue-intake config (before creating a block)', async () => {
    const { service, blockInsert } = makeIntakeService(true)
    await expect(service.create(WS, withIntake())).rejects.toBeInstanceOf(ValidationError)
    expect(blockInsert).not.toHaveBeenCalled()
  })

  it('rejects a bug-intake schedule whose source is not offered (isEnabled would have wrongly passed)', async () => {
    const { service, blockInsert } = makeIntakeService(false)
    const input = withIntake({ source: 'jira', board: { jiraProjectKey: 'P' }, predicates: {} })
    await expect(service.create(WS, input)).rejects.toBeInstanceOf(ValidationError)
    expect(blockInsert).not.toHaveBeenCalled()
  })

  it('accepts a bug-intake schedule pointed at an offered source', async () => {
    const { service, blockInsert, upsert } = makeIntakeService(true)
    const input = withIntake({ source: 'jira', board: { jiraProjectKey: 'P' }, predicates: {} })
    const created = await service.create(WS, input)
    expect(created.issueIntake).toEqual({
      source: 'jira',
      board: { jiraProjectKey: 'P' },
      predicates: {},
    })
    expect(blockInsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('skips the offered-source check when no task-connection service is wired (presence check stands)', async () => {
    const { service, blockInsert } = makeIntakeService(undefined)
    const input = withIntake({ source: 'jira', board: { jiraProjectKey: 'P' }, predicates: {} })
    // No taskConnectionService ⇒ the connected-source half is skipped; a present config passes.
    const created = await service.create(WS, input)
    expect(created.issueIntake).toBeDefined()
    expect(blockInsert).toHaveBeenCalledTimes(1)
  })
})
