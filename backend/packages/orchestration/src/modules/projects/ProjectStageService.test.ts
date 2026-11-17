import type {
  Project,
  ProjectDefinition,
  ProjectStage,
  ProjectStageTask,
} from '@cat-factory/contracts'
import { type Block, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { ProjectStageService } from './ProjectStageService.js'

const project: Project = {
  id: 'prj_1',
  accountId: 'acc_1',
  kind: 'research',
  rootBlockId: 'root_1',
  serviceIds: [],
  createdAt: 0,
}

function stage(id: string, over: Partial<ProjectStage> = {}): ProjectStage {
  return {
    id,
    title: id,
    taskType: 'research',
    after: [],
    consumes: [],
    produces: id,
    start: 'auto',
    checkpoint: false,
    repeatable: false,
    ...over,
  }
}

function harness(opts: { stages: ProjectStage[]; vendor?: string; startFails?: boolean }) {
  const tasks: Block[] = []
  const stageTasks: ProjectStageTask[] = []
  const definition = {
    kind: 'research',
    key: 'acme:staged',
    version: 1,
    title: 'Staged',
    credentials: [],
    targets: [],
    inputs: [],
    promptAdditions: {},
    stages: opts.stages,
    spec: {},
  } satisfies ProjectDefinition
  const records = {
    getPin: vi.fn(async () => ({
      projectId: project.id,
      definitionKey: 'acme:staged',
      definitionVersion: 1,
      definitionHash: 'h1',
      inputs: {},
    })),
    listOutcomes: vi.fn(async () => []),
    listStageTasks: vi.fn(async () => stageTasks),
    insertStageTask: vi.fn(async (row: ProjectStageTask) => {
      if (stageTasks.some((t) => t.stageId === row.stageId && t.recordedAt === null)) return false
      stageTasks.push(row)
      return true
    }),
    markStageTaskRecorded: vi.fn(async () => {}),
    clearStageCheckpoint: vi.fn(async () => false),
    deleteStageTasks: vi.fn(async () => {}),
  }
  const started: string[] = []
  const runs = {
    individualVendorsForBlock: vi.fn(async () => (opts.vendor ? [opts.vendor] : [])),
    start: vi.fn(async (_ws: string, blockId: string) => {
      if (opts.startFails) throw new Error('task limit reached')
      started.push(blockId)
      const task = tasks.find((t) => t.id === blockId)!
      task.executionId = `exec_${blockId}`
    }),
  }
  const logger = createRecordingLogger()
  const service = new ProjectStageService({
    getMounted: async () => ({
      project,
      rootBlock: { id: 'root_1' } as Block,
      homeWorkspaceId: 'ws_home',
    }),
    listTasks: vi.fn(async () => tasks),
    records,
    definitions: {
      get: async () => ({ definition, contentHash: 'h1', origin: 'registered' as const }),
      latest: async () => null,
      list: async () => [],
    },
    board: () => ({
      addTask: async (_ws, _root, input) => {
        const task = {
          id: `task_${tasks.length + 1}`,
          title: input.title,
          taskType: input.taskType,
          pipelineId: 'pl_research',
          executionId: null,
        } as unknown as Block
        tasks.push(task)
        return task
      },
      removeTask: async (_ws, blockId) => {
        tasks.splice(
          tasks.findIndex((t) => t.id === blockId),
          1,
        )
      },
    }),
    runStarter: () => runs,
    clock: { now: () => 5 },
    logger,
  })
  return { service, tasks, stageTasks, started, runs, records, logger }
}

describe('ProjectStageService.advance', () => {
  it('starts a ready automatic stage once, and leaves a manual one for a person', async () => {
    const h = harness({ stages: [stage('discover'), stage('later', { start: 'manual' })] })
    await h.service.advance('ws_home', project.id)
    expect(h.stageTasks.map((t) => t.stageId)).toEqual(['discover'])
    expect(h.started).toEqual(['task_1'])
    // A second trigger finds the stage running and starts nothing.
    await h.service.advance('ws_home', project.id)
    expect(h.started).toEqual(['task_1'])
  })

  it('does not recreate an automatic stage whose task a person deleted', async () => {
    const h = harness({ stages: [stage('discover')] })
    await h.service.advance('ws_home', project.id)
    h.tasks.splice(0, 1)
    await h.service.advance('ws_home', project.id)
    expect(h.tasks).toEqual([])
    expect(h.started).toEqual(['task_1'])
  })

  it('starts the run of a task it created but never started, on the next trigger', async () => {
    const h = harness({ stages: [stage('discover')], startFails: true })
    await h.service.advance('ws_home', project.id)
    expect(h.tasks.map((t) => t.executionId)).toEqual([null])
    expect(h.logger.lines.some((e) => e.level === 'warn')).toBe(true)
    h.runs.start.mockImplementation(async (_ws: string, blockId: string) => {
      h.started.push(blockId)
    })
    await h.service.advance('ws_home', project.id)
    expect(h.stageTasks).toHaveLength(1)
    expect(h.started).toEqual(['task_1'])
  })

  it('leaves a run on an individual-usage model on the board for a person, and says why', async () => {
    const h = harness({ stages: [stage('discover')], vendor: 'anthropic' })
    await h.service.advance('ws_home', project.id)
    expect(h.tasks).toHaveLength(1)
    expect(h.runs.start).not.toHaveBeenCalled()
    expect(JSON.stringify(h.logger.lines)).toContain('individual-usage anthropic')
  })

  it('reads nothing more when the definition starts no stage on its own', async () => {
    const h = harness({ stages: [stage('discover', { start: 'manual' })] })
    await h.service.advance('ws_home', project.id)
    expect(h.records.listStageTasks).not.toHaveBeenCalled()
    expect(h.tasks).toEqual([])
  })
})
