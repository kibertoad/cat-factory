import { describe, expect, it } from 'vitest'
import { hasActionablePark } from '~/modular/nav-gates.logic'
import type { ParkedGateRef } from '~/modular/nav-gates.logic'

const onlyTasks = (id: string) => id.startsWith('task_')
const nothingIsBackground = () => false

describe('hasActionablePark', () => {
  it('reports a park a task card really shows an action for', () => {
    const parks: ParkedGateRef[] = [{ blockId: 'task_login', agentKind: 'architect' }]
    expect(hasActionablePark(parks, onlyTasks, nothingIsBackground)).toBe(true)
  })

  it('ignores a park on a block that renders no task card', () => {
    // A frame/module run parks too, but the affordance the tour anchors on is TaskCard's.
    const parks: ParkedGateRef[] = [{ blockId: 'frame_billing', agentKind: 'blueprints' }]
    expect(hasActionablePark(parks, onlyTasks, nothingIsBackground)).toBe(false)
  })

  it('ignores a reviewer gate the card suppresses as background work', () => {
    // Mirrors `TaskCard.pendingApproval`: while the review is folding answers / re-reviewing
    // it needs no human, so no Resolve button exists to point a tour at.
    const parks: ParkedGateRef[] = [{ blockId: 'task_login', agentKind: 'requirements-review' }]
    const isBackground = (kind: string | undefined) => kind === 'requirements-review'
    expect(hasActionablePark(parks, onlyTasks, isBackground)).toBe(false)
  })

  it('reports the actionable one when a board holds both kinds at once', () => {
    const parks: ParkedGateRef[] = [
      { blockId: 'frame_billing', agentKind: 'architect' },
      { blockId: 'task_login', agentKind: 'requirements-review' },
      { blockId: 'task_signup', agentKind: 'coder' },
    ]
    const isBackground = (kind: string | undefined) => kind === 'requirements-review'
    expect(hasActionablePark(parks, onlyTasks, isBackground)).toBe(true)
  })

  it('is false for a board with nothing parked at all', () => {
    expect(hasActionablePark([], onlyTasks, nothingIsBackground)).toBe(false)
  })
})
