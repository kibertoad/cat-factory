import type { Project, SpawnRecord } from '@cat-factory/contracts'
import { type Block, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { spawnedTaskId, stageSpawner } from './stageSpawner.js'

// The engine half of a spawn stage. A durable driver may replay the step, so a second run must find
// the tasks the first one created rather than creating them again, and a service it cannot put a
// task into is recorded with the reason.

const project: Project = {
  id: 'prj_1',
  accountId: 'acc_1',
  kind: 'delivery',
  rootBlockId: 'root_1',
  serviceIds: ['svc_api', 'svc_gone'],
  createdAt: 1,
}
const stageTask = { id: 'task_stage' } as Block
const frame = { id: 'frame_api', title: 'Api' } as Block

function harness(opts: { frame?: Block } = {}) {
  const created = new Map<string, Block>()
  const addTask = vi.fn(async (_ws: string, _frame: string, input: { title: string }, ..._rest) => {
    const id = (_rest[2] as { id: string }).id
    const block = { id, title: input.title, executionId: null, pipelineId: 'pl_x' } as Block
    created.set(id, block)
    return block
  })
  const start = vi.fn(async (_ws: string, blockId: string) => {
    created.set(blockId, { ...created.get(blockId)!, executionId: 'exec_1' })
  })
  const link = vi.fn(async () => [])
  const linkMany = vi.fn(async () => {})
  const removeTask = vi.fn(async () => {})
  const spawner = stageSpawner({
    serviceRepository: {
      listByIds: async () => [
        {
          id: 'svc_api',
          accountId: 'acc_1',
          frameBlockId: 'frame_api',
          installationId: null,
          repoGithubId: null,
          createdAt: 1,
        },
      ],
    },
    blockRepository: {
      findByIds: async () => [
        { workspaceId: 'ws_home', ownerId: 'svc_api', block: opts.frame ?? frame },
      ],
      getMany: async (_ws, ids) => ids.flatMap((id) => created.get(id) ?? []),
    },
    board: () => ({ addTask, removeTask }),
    runStarter: () => ({ individualVendorsForBlock: async () => [], start }),
    links: { link, linkMany, unlinkAll: async () => {} },
    logger: createRecordingLogger(),
  })
  const run = () =>
    spawner.run({
      workspaceId: 'ws_home',
      project,
      task: stageTask,
      plan: { title: 'Integrate {service}', description: '', taskType: 'feature' },
    }) as Promise<SpawnRecord>
  return { run, addTask, start, linkMany, removeTask }
}

describe('stageSpawner', () => {
  it('creates one task per service, and a replay finds it instead of creating another', async () => {
    const { run, addTask, start } = harness()
    const first = await run()
    const id = spawnedTaskId(stageTask.id, 'svc_api')
    expect(first.tasks).toEqual([
      {
        serviceId: 'svc_api',
        serviceName: 'Api',
        workspaceId: 'ws_home',
        taskId: id,
        title: 'Integrate Api',
        started: true,
      },
    ])
    expect(first.skipped).toEqual([
      { serviceId: 'svc_gone', serviceName: null, reason: 'The service is gone.' },
    ])

    const replay = await run()
    expect(replay).toEqual(first)
    expect(addTask).toHaveBeenCalledTimes(1)
    // The task's run had started, so the replay starts nothing either.
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('removes nothing when the board refuses to create the task', async () => {
    const { run, addTask, removeTask } = harness()
    addTask.mockRejectedValueOnce(new Error('Task type suppressed here'))
    const record = await run()
    expect(record.tasks).toEqual([])
    expect(record.skipped).toContainEqual(
      expect.objectContaining({ serviceId: 'svc_api', reason: 'Task type suppressed here' }),
    )
    expect(removeTask).not.toHaveBeenCalled()
  })

  it('keeps a task an earlier attempt made when linking now fails, so the checkpoint waits on it', async () => {
    const { run, linkMany, start } = harness()
    await run()
    start.mockClear()
    linkMany.mockRejectedValueOnce(new Error('The project cannot be read just now'))
    const replay = await run()
    expect(replay.tasks).toEqual([
      expect.objectContaining({
        taskId: spawnedTaskId(stageTask.id, 'svc_api'),
        started: true,
        note: 'The project cannot be read just now',
      }),
    ])
    expect(start).not.toHaveBeenCalled()
  })

  it('skips an archived service rather than putting work into a subtree no board shows', async () => {
    const { run, addTask } = harness({ frame: { ...frame, archived: true } as Block })
    const record = await run()
    expect(record.skipped[0]).toEqual({
      serviceId: 'svc_api',
      serviceName: 'Api',
      reason: 'The service is archived.',
    })
    expect(addTask).not.toHaveBeenCalled()
  })
})
