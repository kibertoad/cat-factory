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

  // The `test-evidence` deep link the engine puts in every PR verification report knows only the
  // RUN, so the opener has to resolve which tester step the reviewer was pointed at.
  describe('openTestEvidence', () => {
    it('opens the tester step that actually reported, not the first one', () => {
      execution.hydrate(
        [
          instance('e1', 'b1', [
            { agentKind: 'coder' },
            { agentKind: 'tester-api' },
            { agentKind: 'tester-ui', test: { lastReport: { greenlight: true } } },
          ]),
        ],
        'ws1',
      )

      ui.openTestEvidence('e1')

      expect(ui.resultView).toMatchObject({ view: 'tester', instanceId: 'e1', stepIndex: 2 })
    })

    it('still opens a tester step that has not reported, rather than going nowhere', () => {
      execution.hydrate([instance('e1', 'b1', [{ agentKind: 'tester-api' }])], 'ws1')

      ui.openTestEvidence('e1')

      expect(ui.resultView).toMatchObject({ view: 'tester', stepIndex: 0 })
    })

    it('does nothing when the run carries no tester step at all', () => {
      execution.hydrate([instance('e1', 'b1', [{ agentKind: 'coder' }])], 'ws1')

      ui.openTestEvidence('e1')

      expect(ui.resultView).toBeNull()
      expect(ui.stepDetail).toBeNull()
    })
  })

  // The outcome summary is the RUN's, not a step's, and it has two entry points: the board and
  // inspector know the block (and a merged task's run may be gone), while a deep link knows only
  // the run id.
  describe('openOutcome', () => {
    it('opens block-keyed with no step, and with no run when the task has none', () => {
      ui.openOutcome('b1')

      expect(ui.resultView).toEqual({
        view: 'outcome',
        blockId: 'b1',
        instanceId: null,
        stepIndex: null,
      })
    })

    it('carries the run when the caller knows it', () => {
      ui.openOutcome('b1', 'e1')

      expect(ui.resultView).toMatchObject({ view: 'outcome', blockId: 'b1', instanceId: 'e1' })
    })

    it('resolves the block from the run for a run-only caller (the deep link)', () => {
      execution.hydrate([instance('e1', 'b1', [{ agentKind: 'coder' }])], 'ws1')

      ui.openRunOutcome('e1')

      expect(ui.resultView).toEqual({
        view: 'outcome',
        blockId: 'b1',
        instanceId: 'e1',
        stepIndex: null,
      })
    })

    // The link the deep-link consumer passes carries BOTH ids, and the run is only a lookup:
    // following one into a task that finished long ago is the normal case, and the snapshot
    // that hydrates the board is not obliged to still carry that run.
    it('opens on the block the link names even when the run was never hydrated', () => {
      ui.openRunOutcome('missing', 'b1')

      expect(ui.resultView).toEqual({
        view: 'outcome',
        blockId: 'b1',
        instanceId: 'missing',
        stepIndex: null,
      })
    })

    it('does nothing for a run the store has not hydrated and a link with no block', () => {
      ui.openRunOutcome('missing')

      expect(ui.resultView).toBeNull()
    })
  })
})
