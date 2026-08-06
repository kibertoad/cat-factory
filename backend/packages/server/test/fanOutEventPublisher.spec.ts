import type {
  Block,
  BoardChange,
  ExecutionEventPublisher,
  ExecutionInstance,
  LlmCallActivity,
  Notification,
} from '@cat-factory/kernel'
import { NoopEventPublisher } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FanOutEventPublisher } from '../src/events/FanOutEventPublisher.js'

/** A layout-free (non-frame) block, the only kind a board change may carry as a payload. */
function boardBlock(id: string): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: 'frame1',
  }
}

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
  /** The id of the block each delivered board change CARRIED, or `null` when it carried none. */
  boardBlocks: (string | null)[] = []
  notifications: string[] = []
  async executionChanged(ws: string): Promise<void> {
    this.executions.push(ws)
  }
  async boardChanged(ws: string, change: BoardChange): Promise<void> {
    this.boards.push(ws)
    this.boardBlocks.push(change.block?.id ?? null)
  }
  async notificationChanged(ws: string): Promise<void> {
    this.notifications.push(ws)
  }
  llmCalls: string[] = []
  async llmCallObserved(ws: string): Promise<void> {
    this.llmCalls.push(ws)
  }
  infraChanges: string[] = []
  async infraSetupChanged(ws: string): Promise<void> {
    this.infraChanges.push(ws)
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
    await fanOut.boardChanged('wsA', { reason: 'module-materialised' })
    expect(inner.boards).toEqual(['wsA'])
  })

  it('fans a boardChanged naming a shared block out to every mounting workspace', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB']),
    })
    // A structural change to a shared service (named by one of its blocks) reaches both boards.
    await fanOut.boardChanged('wsA', { reason: 'blueprint-reconciled', blockId: 'frame1' })
    expect(inner.boards.sort()).toEqual(['wsA', 'wsB'])
  })

  it('resolves the fan-out from a carried block when no blockId is given', async () => {
    const queried: string[] = []
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB'], (id) => queried.push(id)),
    })
    // A targeted change names its subject through the payload, and callers holding the block do
    // not restate its id. If the decorator read `blockId` alone, every targeted event would
    // collapse to the origin board and a mounted service would silently stop updating live.
    await fanOut.boardChanged('wsA', { reason: 'block-added', block: boardBlock('task1') })
    expect(queried).toEqual(['task1'])
    expect(inner.boards.sort()).toEqual(['wsA', 'wsB'])
  })

  it('delivers the same carried block to every target', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      workspaceMountRepository: mountRepo(['wsA', 'wsB']),
    })
    const block = boardBlock('task1')
    await fanOut.boardChanged('wsA', { reason: 'block-updated', block })
    // Every mounting board gets the payload, not just the origin: a mounted service's tasks patch
    // in place there too. Soundness rests on the payload being layout-free, which is
    // `deliverableBoardBlock`'s job at the wire (a frame never reaches here as a payload).
    expect(inner.boardBlocks).toEqual([block.id, block.id])
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

  it('delivers an infraSetup transition to the origin only (the projection is per-board)', async () => {
    const inner = new RecordingPublisher()
    const fanOut = new FanOutEventPublisher(inner, {
      // A reachability transition carries no block id, so the mount join must never be consulted —
      // and a board mounting a shared service reads its OWN infra wiring, so there is nothing to
      // fan out even if it did.
      workspaceMountRepository: mountRepo(['wsA', 'wsB'], () => {
        throw new Error('should not be queried for an infraSetup change')
      }),
    })
    await fanOut.infraSetupChanged('wsA', { area: 'agentExecutor', status: 'unreachable' })
    expect(inner.infraChanges).toEqual(['wsA'])
  })

  it('forwards every optional publisher method the port declares', () => {
    // This decorator delegates method-by-method, so an event it does not name is silently DROPPED
    // for every deployment that wires the fan-out — nothing throws, nothing logs, the browser just
    // never updates. Reflecting the port's own surface (via the Noop implementation, which
    // implements all of it) is what makes the next added event fail HERE instead of in production.
    const fanOut = new FanOutEventPublisher(new RecordingPublisher(), {
      workspaceMountRepository: mountRepo([]),
    })
    const declared = Object.getOwnPropertyNames(NoopEventPublisher.prototype).filter(
      (name) => name !== 'constructor',
    )
    const missing = declared.filter(
      (name) => typeof (fanOut as unknown as Record<string, unknown>)[name] !== 'function',
    )
    expect(missing).toEqual([])
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
