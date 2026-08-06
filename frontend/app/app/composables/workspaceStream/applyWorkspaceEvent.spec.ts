import { describe, expect, it, vi } from 'vitest'
import type { Block, WorkspaceEvent } from '~/types/domain'
import {
  applyWorkspaceEvent,
  type WorkspaceEventTargets,
} from '~/composables/workspaceStream/applyWorkspaceEvent'

function targets(): WorkspaceEventTargets & { calls: string[] } {
  const calls: string[] = []
  const record =
    <T extends unknown[]>(name: string) =>
    (...args: T) => {
      void args
      calls.push(name)
    }
  return {
    calls,
    upsertExecution: record('upsertExecution'),
    upsertBlock: record('upsertBlock'),
    upsertBootstrap: record('upsertBootstrap'),
    upsertEnvConfigRepair: record('upsertEnvConfigRepair'),
    upsertEnvironmentTest: record('upsertEnvironmentTest'),
    patchInfraSetup: record('patchInfraSetup'),
    upsertNotification: record('upsertNotification'),
    appendLlmCall: record('appendLlmCall'),
    upsertRequirements: record('upsertRequirements'),
    upsertConsensus: record('upsertConsensus'),
    upsertClarity: record('upsertClarity'),
    upsertBrainstorm: record('upsertBrainstorm'),
    upsertKaizen: record('upsertKaizen'),
    upsertInitiative: record('upsertInitiative'),
    upsertDocInterview: record('upsertDocInterview'),
    refreshBoard: record('refreshBoard'),
  }
}

const task = {
  id: 'blk_task',
  title: 'Ship it',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'planned',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'task',
  parentId: 'blk_frame',
} as unknown as Block

describe('applyWorkspaceEvent: the board branch', () => {
  it('patches the carried block instead of refreshing the whole board', () => {
    const to = targets()
    const event: WorkspaceEvent = { type: 'board', reason: 'block-added', block: task, at: 1 }

    applyWorkspaceEvent(event, to)

    // The whole point of the change: a spawned task costs one upsert, not a snapshot fetch that
    // REPLACES every store's list.
    expect(to.calls).toEqual(['upsertBlock'])
  })

  it('falls back to a full refresh when the change carries no block', () => {
    const to = targets()
    // Everything the publisher withholds a payload for lands here: a removal that cascades, a
    // reparent that moves a subtree, and a service FRAME whose geometry is per-board. None has a
    // single block that states the new shape, so the client must re-read its own projection.
    const event: WorkspaceEvent = { type: 'board', reason: 'block-removed', at: 1 }

    applyWorkspaceEvent(event, to)

    expect(to.calls).toEqual(['refreshBoard'])
  })

  it('falls back to a full refresh when the payload is explicitly null', () => {
    const to = targets()
    // The frame shape as the publishers actually emit it: `deliverableBoardBlock` answers `null`
    // rather than omitting the key, and an absent payload and a null one must route identically.
    const event: WorkspaceEvent = { type: 'board', reason: 'block-archived', block: null, at: 1 }

    applyWorkspaceEvent(event, to)

    expect(to.calls).toEqual(['refreshBoard'])
  })

  it('routes a board event through the SAME upsert an execution event uses', () => {
    // Coherence: the monotonic live-upsert stamp that stops a stale refresh clobbering newer
    // state lives in `board.upsert`. A targeted board event that patched `blocks` any other way
    // would silently escape that guard.
    const upsertBlock = vi.fn()
    const to = { ...targets(), upsertBlock }

    applyWorkspaceEvent({ type: 'board', reason: 'block-updated', block: task, at: 1 }, to)
    applyWorkspaceEvent(
      {
        type: 'execution',
        instance: { id: 'exec_1', blockId: task.id } as never,
        block: task,
        at: 2,
      },
      to,
    )

    expect(upsertBlock).toHaveBeenCalledTimes(2)
    expect(upsertBlock).toHaveBeenNthCalledWith(1, task)
    expect(upsertBlock).toHaveBeenNthCalledWith(2, task)
  })
})

describe('applyWorkspaceEvent: the other branches', () => {
  it('keeps every non-board event on its own targeted store call', () => {
    // Each type below is delivered as a patch rather than a board refresh. This table cannot see
    // a NEW event type (an absent member is just absent from a hand-written list). That job
    // belongs to the `never` guard on the switch's `default`, which fails the BUILD instead.
    const cases: [WorkspaceEvent, string][] = [
      [{ type: 'bootstrap', job: {} as never, block: null, at: 1 }, 'upsertBootstrap'],
      [{ type: 'env-config-repair', job: {} as never, at: 1 }, 'upsertEnvConfigRepair'],
      [{ type: 'envTest', run: {} as never, at: 1 }, 'upsertEnvironmentTest'],
      [
        { type: 'infraSetup', area: 'runnerPool' as never, status: 'ok' as never, at: 1 },
        'patchInfraSetup',
      ],
      [{ type: 'notification', notification: {} as never, at: 1 }, 'upsertNotification'],
      [{ type: 'llmCall', call: {} as never, at: 1 }, 'appendLlmCall'],
      [{ type: 'requirements', review: {} as never, at: 1 }, 'upsertRequirements'],
      [{ type: 'consensus', session: {} as never, at: 1 }, 'upsertConsensus'],
      [{ type: 'clarity', review: {} as never, at: 1 }, 'upsertClarity'],
      [{ type: 'brainstorm', session: {} as never, at: 1 }, 'upsertBrainstorm'],
      [{ type: 'kaizen', grading: {} as never, at: 1 }, 'upsertKaizen'],
      [{ type: 'initiative', initiative: {} as never, at: 1 }, 'upsertInitiative'],
      [{ type: 'docInterview', session: {} as never, at: 1 }, 'upsertDocInterview'],
    ]

    for (const [event, expected] of cases) {
      const to = targets()
      applyWorkspaceEvent(event, to)
      expect(to.calls, `${event.type} should route to ${expected}`).toEqual([expected])
    }
  })

  it('drops an event type it does not know rather than tearing down the session', () => {
    // A backend one release ahead pushes types this build has never heard of. The socket carries
    // every other event for the whole workspace, so the unknown one is dropped, not thrown on.
    const to = targets()

    applyWorkspaceEvent({ type: 'a-later-release', at: 1 } as unknown as WorkspaceEvent, to)

    expect(to.calls).toEqual([])
  })
})
