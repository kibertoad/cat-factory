import { describe, expect, it } from 'vitest'
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { RecurringPipelineService } from './RecurringPipelineService.js'
import type { RecurringPipelineServiceDependencies } from './RecurringPipelineService.js'

// Removing a schedule deletes the task block it reuses, and a person can attach images to that
// task in the inspector. Those are retained until their block goes, so this delete has to reclaim
// them the way a board delete does, or they outlive the task with nothing left to name them.
describe('RecurringPipelineService.remove', () => {
  it('reclaims the artifacts the removed block carried, after the block is gone', async () => {
    const order: string[] = []
    const pruned: { ws: string; ids: readonly string[] }[] = []
    const deps = {
      pipelineScheduleRepository: {
        get: async () => ({ id: 'sch_1', blockId: 'blk_task' }),
        remove: async () => void order.push('schedule'),
      },
      workspaceRepository: { get: async (id: string) => ({ id }) },
      executionRepository: { deleteByBlock: async () => void order.push('runs') },
      blockRepository: { deleteMany: async () => void order.push('block') },
      resolveBinaryArtifactStore: async () =>
        ({
          pruneByBlocks: async (ws: string, ids: readonly string[]) => {
            order.push('artifacts')
            pruned.push({ ws, ids })
            return ids.length
          },
        }) as unknown as BinaryArtifactStore,
    } as unknown as RecurringPipelineServiceDependencies

    await new RecurringPipelineService(deps).remove('ws_1', 'sch_1')

    expect(pruned).toEqual([{ ws: 'ws_1', ids: ['blk_task'] }])
    expect(order).toEqual(['runs', 'block', 'artifacts', 'schedule'])
  })
})
