import { describe, expect, it, vi } from 'vitest'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useRunGate } from '~/composables/useRunGate'

// The lock both run surfaces share. The board store is real; only the caller's run permission is
// stubbed, since the auth gate is not what these assertions are about.
const task = (over: Partial<Block>) => ({ level: 'task', dependsOn: [], ...over }) as Block

function setup(canExecuteRuns: boolean) {
  vi.stubGlobal('useWorkspaceAccess', () => ({ canExecuteRuns: { value: canExecuteRuns } }))
  useBoardStore().hydrate([
    task({ id: 'done', title: 'Done', status: 'done' }),
    task({ id: 'open', title: 'Open', status: 'in_progress' }),
    task({ id: 't', title: 'Task', status: 'planned', dependsOn: ['done', 'open'] }),
    task({ id: 'free', title: 'Free', status: 'planned' }),
  ])
}

describe('useRunGate', () => {
  it('lets a member start a task with no outstanding dependency', () => {
    setup(true)
    const gate = useRunGate('free')
    expect(gate.canRun.value).toBe(true)
    expect(gate.blockedReason.value).toBeNull()
  })

  it('locks a task whose dependency has not merged, and says so', () => {
    setup(true)
    const gate = useRunGate('t')
    expect(gate.canRun.value).toBe(false)
    expect(gate.blockedReason.value).toBe('panels.inspector.runBlocked')
  })

  it('locks a caller who may not execute runs, ahead of any dependency', () => {
    setup(false)
    const gate = useRunGate('t')
    expect(gate.canRun.value).toBe(false)
    expect(gate.blockedReason.value).toBe('access.noRunExecute')
  })
})
