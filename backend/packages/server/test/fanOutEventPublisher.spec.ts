import type {
  ExecutionEventPublisher,
  ExecutionInstance,
  Notification,
  WorkspaceMount,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FanOutEventPublisher } from '../src/events/FanOutEventPublisher.js'

function execInstance(blockId: string): ExecutionInstance {
  return {
    id: 'ex1',
    blockId,
    pipelineId: 'pl',
    pipelineName: 'Pipeline',
    steps: [],
    currentStep: 0,
    status: 'running',
  }
}

function mount(workspaceId: string, serviceId: string): WorkspaceMount {
  return { workspaceId, serviceId, position: { x: 0, y: 0 }, size: null, createdAt: 0 }
}

/** Records which workspace each event was delivered to. */
class RecordingPublisher implements ExecutionEventPublisher {
  executions: string[] = []
  boards: string[] = []
  notifications: string[] = []
  async executionChanged(ws: string): Promise<void> {
    this.executions.push(ws)
  }
  async boardChanged(ws: string): Promise<void> {
    this.boards.push(ws)
  }
  async notificationChanged(ws: string): Promise<void> {
    this.notifications.push(ws)
  }
}

describe('FanOutEventPublisher', () => {
  it("delivers a shared service's events to every workspace that mounts it", async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      blockRepository: { serviceIdOf: async () => 'svc1' },
      workspaceMountRepository: {
        listByService: async () => [mount('wsA', 'svc1'), mount('wsB', 'svc1')],
      },
    })

    // The engine addresses wsA (the home); the event must also reach wsB.
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(inner.executions.sort()).toEqual(['wsA', 'wsB'])
  })

  it('includes the originating workspace even if it has no mount row', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      blockRepository: { serviceIdOf: async () => 'svc1' },
      workspaceMountRepository: { listByService: async () => [mount('wsB', 'svc1')] },
    })
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(inner.executions.sort()).toEqual(['wsA', 'wsB'])
  })

  it('falls back to the origin workspace when the block has no service', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      blockRepository: { serviceIdOf: async () => null },
      workspaceMountRepository: { listByService: async () => [] },
    })
    const notification = { id: 'n1', blockId: 'task1' } as Notification
    await fanOut.notificationChanged('wsA', notification)
    expect(inner.notifications).toEqual(['wsA'])
  })

  it('delivers coarse boardChanged to the origin only (no block context)', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      blockRepository: {
        serviceIdOf: async () => {
          throw new Error('should not be called without a block')
        },
      },
      workspaceMountRepository: { listByService: async () => [] },
    })
    await fanOut.boardChanged('wsA', 'module-materialised')
    expect(inner.boards).toEqual(['wsA'])
  })
})
