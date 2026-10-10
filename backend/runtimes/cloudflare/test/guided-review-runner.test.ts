import type { Workflow } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { WorkflowsGuidedReviewRunner } from '../src/infrastructure/workflows/WorkflowsGuidedReviewRunner'

describe('WorkflowsGuidedReviewRunner', () => {
  it('creates a fresh instance per delivery, so a re-drive is never refused as a reused id', async () => {
    const created: { id: string; params: unknown }[] = []
    const workflow = {
      create: async (options: { id: string; params: unknown }) => {
        created.push(options)
        return {}
      },
    } as unknown as Workflow
    let now = 1000
    const runner = new WorkflowsGuidedReviewRunner(workflow, () => now++)
    const job = { kind: 'overview' as const, sessionId: 'grs_1', generation: 2 }

    await runner.start('ws_1', job)
    await runner.start('ws_1', job)

    expect(created.map((c) => c.id)).toEqual(['gro-grs_1-2-1000', 'gro-grs_1-2-1001'])
    expect(created[0]?.params).toEqual({ workspaceId: 'ws_1', job })
  })
})
