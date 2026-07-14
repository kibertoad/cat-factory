import type {
  ExecutionEventPublisher,
  ExecutionInstance,
  LlmCallActivity,
  Notification,
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

/**
 * A stand-in mount repo. `mounting` is the set of workspace ids whose mounts reference the
 * service that owns the queried block (the join the real repo does in one query); the origin is
 * NOT implied — the publisher unions it in. `[]` models a block with no service.
 */
function mountRepo(mounting: string[], onCall?: (blockId: string) => void) {
  return {
    async listWorkspaceIdsMountingBlock(_originWorkspaceId: string, blockId: string) {
      onCall?.(blockId)
      return mounting
    },
  }
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
  llmCalls: string[] = []
  async llmCallObserved(ws: string): Promise<void> {
    this.llmCalls.push(ws)
  }
}

describe('FanOutEventPublisher', () => {
  it("delivers a shared service's events to every workspace that mounts it", async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB']),
    })

    // The engine addresses wsA (the home); the event must also reach wsB.
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(inner.executions.sort()).toEqual(['wsA', 'wsB'])
  })

  it('includes the originating workspace even if it has no mount row', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsB']),
    })
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(inner.executions.sort()).toEqual(['wsA', 'wsB'])
  })

  it('falls back to the origin workspace when the block has no service', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo([]),
    })
    const notification = { id: 'n1', blockId: 'task1' } as Notification
    await fanOut.notificationChanged('wsA', notification)
    expect(inner.notifications).toEqual(['wsA'])
  })

  it('delivers coarse boardChanged to the origin only (no block context)', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo([], () => {
        throw new Error('should not be queried without a block')
      }),
    })
    await fanOut.boardChanged('wsA', 'module-materialised')
    expect(inner.boards).toEqual(['wsA'])
  })

  it('fans a boardChanged naming a shared block out to every mounting workspace', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB']),
    })
    // A structural change to a shared service (named by one of its blocks) reaches both boards.
    await fanOut.boardChanged('wsA', 'blueprint-reconciled', 'frame1')
    expect(inner.boards.sort()).toEqual(['wsA', 'wsB'])
  })

  it('stops fanning out to a workspace once it has unmounted the service', async () => {
    const inner = new RecordingPublisher()
    // wsB has unmounted: the join no longer returns it, so the event reaches the origin only.
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA']),
    })
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(inner.executions.sort()).toEqual(['wsA'])
  })

  it('delivers an llmCall activity to the origin only (no block context to fan out)', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      // The activity carries no block id, so the mount join must never be consulted.
      workspaceMountRepository: mountRepo(['wsA', 'wsB'], () => {
        throw new Error('should not be queried for an llmCall')
      }),
    })
    await fanOut.llmCallObserved('wsA', { executionId: 'ex1' } as LlmCallActivity)
    expect(inner.llmCalls).toEqual(['wsA'])
  })

  it('resolves targets with a single mount-repo query per event', async () => {
    const inner = new RecordingPublisher()
    let calls = 0
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB'], () => {
        calls++
      }),
    })
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(calls).toBe(1)
  })

  it('forwards to the target workspaces concurrently, not one after another', async () => {
    // Each inner forward blocks until every target has entered — a serial `for await` chain
    // would deadlock (the second forward never starts), so completing proves concurrency.
    let entered = 0
    let release!: () => void
    const allEntered = new Promise<void>((r) => {
      release = r
    })
    const inner = {
      async executionChanged() {
        entered++
        if (entered === 3) release()
        await allEntered
      },
    } as unknown as ExecutionEventPublisher
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsB', 'wsC']),
    })
    await fanOut.executionChanged('wsA', execInstance('task1'))
    expect(entered).toBe(3)
  })
})
