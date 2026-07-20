import { beforeEach, describe, expect, it } from 'vitest'
import { useExecutionStore } from '~/stores/execution'
import { useUiStore } from '~/stores/ui'
import type { ExecutionInstance } from '~/types/domain'

/**
 * Pins the `dispatchStepView` routing seam (the single dispatch every board/inspector/rail
 * entry point uses). Its subtle case is the parked `pr-reviewer` step: it carries BOTH a
 * pending approval and `prReview.status`, so a naive route sends the generic approval button
 * into the prose panel (the #1261 bug). These assertions lock in that a step carrying
 * `prReview` opens the dedicated findings window regardless of catalog/manifest state, and
 * that the consensus MODE still wins over it.
 */
function instance(id: string, blockId: string, steps: unknown[]): ExecutionInstance {
  return { id, blockId, steps } as unknown as ExecutionInstance
}

describe('dispatchStepView routing', () => {
  let ui: ReturnType<typeof useUiStore>
  let execution: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    ui = useUiStore()
    execution = useExecutionStore()
  })

  it('routes a step carrying prReview to the dedicated pr-review window', () => {
    execution.hydrate(
      [
        instance('e1', 'b1', [
          {
            agentKind: 'pr-reviewer',
            approval: { id: 'a1', status: 'pending' },
            prReview: { status: 'awaiting_selection' },
          },
        ]),
      ],
      'ws1',
    )

    ui.openStepDetail('e1', 0)

    expect(ui.resultView).toEqual({
      view: 'pr-review',
      blockId: 'b1',
      instanceId: 'e1',
      stepIndex: 0,
    })
    // The generic prose panel is NOT opened — routing bypassed it.
    expect(ui.stepDetail).toBeNull()
  })

  it('opening the pending approval on a pr-reviewer step still lands on pr-review', () => {
    execution.hydrate(
      [
        instance('e1', 'b1', [
          {
            agentKind: 'pr-reviewer',
            approval: { id: 'a1', status: 'pending' },
            prReview: { status: 'awaiting_selection' },
          },
        ]),
      ],
      'ws1',
    )

    // Every surface's generic approval button funnels through openApprovalDetail → dispatch.
    ui.openApprovalDetail('e1', 'a1')

    expect(ui.resultView?.view).toBe('pr-review')
  })

  it('a consensus run wins over prReview (mode precedence)', () => {
    execution.hydrate(
      [
        instance('e1', 'b1', [
          {
            agentKind: 'pr-reviewer',
            consensus: { enabled: true },
            prReview: { status: 'awaiting_selection' },
          },
        ]),
      ],
      'ws1',
    )

    ui.openStepDetail('e1', 0)

    expect(ui.resultView?.view).toBe('consensus-session')
  })

  it('a plain step with no bespoke view falls back to the generic step-detail panel', () => {
    execution.hydrate([instance('e1', 'b1', [{ agentKind: 'coder' }])], 'ws1')

    ui.openStepDetail('e1', 0)

    expect(ui.resultView).toBeNull()
    expect(ui.stepDetail).toEqual({ instanceId: 'e1', stepIndex: 0 })
  })
})
