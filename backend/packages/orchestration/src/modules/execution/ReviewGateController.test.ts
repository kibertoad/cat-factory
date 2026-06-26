import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import {
  ReviewGateController,
  type ReviewGateControllerDeps,
  type ReviewKind,
  type ReviewPreset,
} from './ReviewGateController.js'
import type { ReviewCommon } from '../review/IterativeReviewService.js'

// The controller owns the gate control flow only; every engine primitive + the review
// service are injected. These fakes record the calls so each branch can be asserted
// without a DB, a durable driver or an LLM. One kind exercises all the generic code (the
// controller never branches on which kind it is handling — that lives in the kind config).

const PRESET: ReviewPreset = { maxRequirementIterations: 6, maxRequirementConcernAllowed: 'none' }

interface FakeReview extends ReviewCommon {}

function review(over: Partial<FakeReview> = {}): FakeReview {
  return {
    id: 'rrv_1',
    blockId: 'blk_1',
    status: 'ready',
    items: [],
    model: 'fake:model',
    iteration: 1,
    maxIterations: 6,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'requirements-review',
    state: 'running',
    progress: 0,
    ...over,
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[], over: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'running',
    currentStep: 0,
    steps,
    ...over,
  } as unknown as ExecutionInstance
}

const BLOCK = { id: 'blk_1', executionId: 'exec_1' } as unknown as Block

/** A controllable kind whose service operations are spies; `currentReview` drives the flow. */
function fakeKind() {
  let current: FakeReview = review()
  const k = {
    agentKind: 'requirements-review',
    entityName: 'Requirement review',
    enabled: vi.fn(() => true),
    getForBlock: vi.fn(async () => current),
    review: vi.fn(async () => current),
    reReview: vi.fn(async () => current),
    incorporate: vi.fn(async () => {}),
    markIncorporated: vi.fn(async () => ({ ...current, status: 'incorporated' as const })),
    markReReviewing: vi.fn(async () => current),
    markIncorporating: vi.fn(async () => ({ ...current, status: 'incorporating' as const })),
    grantExtraRound: vi.fn(async () => current),
    prepareRecommendations: vi.fn(async () => current),
    markRecommendationPending: vi.fn(async () => current),
    fillRecommendations: vi.fn(async () => current),
    emit: vi.fn(async () => {}),
  } satisfies ReviewKind<FakeReview> & Record<string, unknown>
  return {
    kind: k as unknown as ReviewKind<FakeReview>,
    set: (r: FakeReview) => {
      current = r
    },
  }
}

function fakeDeps(over: Partial<ReviewGateControllerDeps> = {}) {
  const deps = {
    blockRepository: { get: vi.fn(async () => BLOCK) },
    executionRepository: { get: vi.fn(async () => null), upsert: vi.fn(async () => {}) },
    workRunner: { signalDecision: vi.fn(async () => {}) },
    resolveMergePreset: vi.fn(async () => PRESET),
    parkStepOnDecision: vi.fn(async (_ws, _i, s: PipelineStep) => {
      s.state = 'waiting_decision'
      return { kind: 'awaiting_decision', decisionId: 'appr_1' } as const
    }),
    advancePastResolvedGate: vi.fn(async () => {}),
    dispatchIterationCap: vi.fn(async () => {}),
    raiseDecisionRequired: vi.fn(async () => {}),
    finishStep: vi.fn((s: PipelineStep) => {
      s.state = 'done'
    }),
    startStep: vi.fn(),
    updateBlockProgress: vi.fn(async () => {}),
    finalizeBlock: vi.fn(async () => {}),
    stopRunContainer: vi.fn(async () => {}),
    persistInstance: vi.fn(async () => {}),
    emitInstance: vi.fn(async () => {}),
    ...over,
  }
  return deps as unknown as ReviewGateControllerDeps & typeof deps
}

describe('ReviewGateController.evaluate', () => {
  let deps: ReturnType<typeof fakeDeps>
  let ctrl: ReviewGateController
  let k: ReturnType<typeof fakeKind>

  beforeEach(() => {
    deps = fakeDeps()
    ctrl = new ReviewGateController(deps)
    k = fakeKind()
  })

  it('passes through (advances) when the reviewer is not wired', async () => {
    ;(k.kind.enabled as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const s = step()
    const inst = instance([s, step({ agentKind: 'architect' })])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(result).toEqual({ kind: 'continue' })
    expect(k.kind.review).not.toHaveBeenCalled()
    expect(deps.finishStep).toHaveBeenCalledWith(s)
    expect(deps.startStep).toHaveBeenCalledTimes(1)
    expect(inst.currentStep).toBe(1)
  })

  it('finishes the run when the pass-through step is final', async () => {
    ;(k.kind.enabled as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const s = step()
    const inst = instance([s])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, true)
    expect(result).toEqual({ kind: 'done' })
    expect(inst.status).toBe('done')
    expect(deps.finalizeBlock).toHaveBeenCalled()
    expect(deps.stopRunContainer).toHaveBeenCalled()
  })

  it('auto-pass (status incorporated) advances without parking', async () => {
    k.set(review({ status: 'incorporated' }))
    const s = step()
    const inst = instance([s, step({ agentKind: 'architect' })])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(result).toEqual({ kind: 'continue' })
    expect(k.kind.review).toHaveBeenCalled()
    expect(deps.parkStepOnDecision).not.toHaveBeenCalled()
  })

  it('parks the run when the fresh review raises findings', async () => {
    k.set(review({ status: 'ready' }))
    const s = step()
    const inst = instance([s])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(deps.parkStepOnDecision).toHaveBeenCalledWith('ws', inst, s)
    expect(deps.raiseDecisionRequired).not.toHaveBeenCalled()
  })

  it('raises a decision-required notification when a fresh review hits the cap', async () => {
    k.set(review({ status: 'exceeded' }))
    const s = step()
    const inst = instance([s])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(deps.raiseDecisionRequired).toHaveBeenCalledWith('ws', inst)
    expect(deps.parkStepOnDecision).toHaveBeenCalled()
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
  })

  it('raises a decision-required notification when a re-entry re-review hits the cap', async () => {
    k.set(review({ status: 'ready', items: [{ status: 'answered' } as never] }))
    ;(k.kind.reReview as ReturnType<typeof vi.fn>).mockResolvedValue(review({ status: 'exceeded' }))
    const s = step({ pendingIncorporation: { feedback: 'do X' } })
    const inst = instance([s])
    await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(deps.raiseDecisionRequired).toHaveBeenCalledWith('ws', inst)
    expect(deps.parkStepOnDecision).toHaveBeenCalled()
  })

  it('re-entry: a pending incorporation folds + re-reviews, then advances on convergence', async () => {
    k.set(review({ status: 'ready', items: [{ status: 'answered' } as never] }))
    // The fold runs, then re-review converges.
    ;(k.kind.reReview as ReturnType<typeof vi.fn>).mockResolvedValue(
      review({ status: 'incorporated' }),
    )
    const s = step({ pendingIncorporation: { feedback: 'do X' } })
    const inst = instance([s, step({ agentKind: 'architect' })])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(s.pendingIncorporation).toBeNull()
    expect(k.kind.incorporate).toHaveBeenCalledWith('ws', 'blk_1', 'rrv_1', 'do X')
    expect(k.kind.markReReviewing).toHaveBeenCalled()
    expect(k.kind.reReview).toHaveBeenCalled()
    expect(result).toEqual({ kind: 'continue' })
    expect(deps.parkStepOnDecision).not.toHaveBeenCalled()
  })

  it('re-entry: re-parks when the re-review still has findings', async () => {
    k.set(review({ status: 'ready', items: [{ status: 'answered' } as never] }))
    ;(k.kind.reReview as ReturnType<typeof vi.fn>).mockResolvedValue(review({ status: 'ready' }))
    const s = step({ pendingIncorporation: { feedback: 'do X' } })
    const inst = instance([s])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(deps.parkStepOnDecision).toHaveBeenCalled()
  })

  it('re-entry with nothing to incorporate settles directly (no fold/re-review LLM calls)', async () => {
    // No answered replies, no feedback, no open items → hasNotesToIncorporate is false.
    k.set(review({ status: 'ready', items: [] }))
    const s = step({ pendingIncorporation: {} })
    const inst = instance([s, step({ agentKind: 'architect' })])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(k.kind.markIncorporated).toHaveBeenCalled()
    expect(k.kind.incorporate).not.toHaveBeenCalled()
    expect(k.kind.reReview).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'continue' })
  })

  it('re-entry: a pending recommendation runs the Writer then re-parks (never advances)', async () => {
    k.set(review({ status: 'ready' }))
    const s = step({
      state: 'waiting_decision',
      approval: { id: 'appr_2', status: 'pending', proposal: '' },
      pendingRecommendation: { itemIds: ['rri_1'] },
    } as Partial<PipelineStep>)
    const inst = instance([s, step({ agentKind: 'architect' })])
    const result = await ctrl.evaluate(k.kind, 'ws', inst, s, BLOCK, false)
    expect(s.pendingRecommendation).toBeNull()
    expect(k.kind.fillRecommendations).toHaveBeenCalledWith('ws', 'blk_1')
    // Recommendations never advance the run — it re-parks for the human to accept/reject.
    expect(deps.parkStepOnDecision).toHaveBeenCalledWith('ws', inst, s)
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(deps.finishStep).not.toHaveBeenCalled()
  })
})

describe('ReviewGateController public surface', () => {
  let deps: ReturnType<typeof fakeDeps>
  let ctrl: ReviewGateController
  let k: ReturnType<typeof fakeKind>

  beforeEach(() => {
    deps = fakeDeps()
    ctrl = new ReviewGateController(deps)
    k = fakeKind()
  })

  it('review resolves the preset and delegates to the kind', async () => {
    k.set(review({ status: 'ready' }))
    const out = await ctrl.review(k.kind, 'ws', 'blk_1')
    expect(deps.resolveMergePreset).toHaveBeenCalled()
    expect(k.kind.review).toHaveBeenCalledWith('ws', BLOCK, PRESET)
    expect(out.status).toBe('ready')
  })

  it('incorporate rejects when findings are still open', async () => {
    k.set(review({ items: [{ status: 'open' } as never] }))
    await expect(ctrl.incorporate(k.kind, 'ws', 'blk_1')).rejects.toBeInstanceOf(ValidationError)
  })

  it('incorporate runs inline when no run is parked on the gate', async () => {
    k.set(review({ status: 'ready', items: [{ status: 'answered' } as never] }))
    // No execution → no parked step.
    deps.executionRepository.get = vi.fn(async () => null)
    await ctrl.incorporate(k.kind, 'ws', 'blk_1', 'feedback')
    // Inline path runs the incorporation cycle (fold + re-review), never signals a driver.
    expect(k.kind.incorporate).toHaveBeenCalled()
    expect(deps.workRunner.signalDecision).not.toHaveBeenCalled()
  })

  it('incorporate offloads to the durable driver when a run is parked', async () => {
    k.set(review({ status: 'ready', items: [{ status: 'answered' } as never] }))
    const parkedStep = step({
      state: 'waiting_decision',
      approval: { id: 'appr_9', status: 'pending', proposal: '' },
    })
    const inst = instance([parkedStep], { status: 'blocked' })
    deps.executionRepository.get = vi.fn(async () => inst)
    const out = await ctrl.incorporate(k.kind, 'ws', 'blk_1', 'feedback')
    expect(parkedStep.pendingIncorporation).toEqual({ feedback: 'feedback' })
    expect(inst.status).toBe('running') // re-armed before signalling
    expect(k.kind.markIncorporating).toHaveBeenCalled()
    expect(deps.workRunner.signalDecision).toHaveBeenCalledWith(
      'ws',
      'exec_1',
      'appr_9',
      'incorporate',
    )
    expect(out.status).toBe('incorporating')
    // It does NOT run the fold inline — that happens in the driver re-entry.
    expect(k.kind.incorporate).not.toHaveBeenCalled()
  })

  it('reReview requires a merged document first', async () => {
    k.set(review({ status: 'ready' }))
    await expect(ctrl.reReview(k.kind, 'ws', 'blk_1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('reReview resumes the parked run on convergence', async () => {
    k.set(review({ status: 'merged' }))
    ;(k.kind.reReview as ReturnType<typeof vi.fn>).mockResolvedValue(
      review({ status: 'incorporated' }),
    )
    const parkedStep = step({
      state: 'waiting_decision',
      approval: { id: 'appr_3', status: 'pending', proposal: '' },
    })
    deps.executionRepository.get = vi.fn(async () => instance([parkedStep]))
    await ctrl.reReview(k.kind, 'ws', 'blk_1')
    expect(deps.advancePastResolvedGate).toHaveBeenCalled()
  })

  it('reReview that still has findings does NOT resume', async () => {
    k.set(review({ status: 'merged' }))
    ;(k.kind.reReview as ReturnType<typeof vi.fn>).mockResolvedValue(review({ status: 'ready' }))
    await ctrl.reReview(k.kind, 'ws', 'blk_1')
    expect(deps.advancePastResolvedGate).not.toHaveBeenCalled()
  })

  it('proceed settles the review and resumes the parked run', async () => {
    k.set(review({ status: 'exceeded' }))
    const parkedStep = step({
      state: 'waiting_decision',
      approval: { id: 'appr_5', status: 'pending', proposal: '' },
    })
    deps.executionRepository.get = vi.fn(async () => instance([parkedStep]))
    const out = await ctrl.proceed(k.kind, 'ws', 'blk_1')
    expect(k.kind.markIncorporated).toHaveBeenCalled()
    expect(deps.advancePastResolvedGate).toHaveBeenCalled()
    expect(out.status).toBe('incorporated')
  })

  it('resolveExceeded dispatches the iteration-cap choice with grant/proceed handlers', async () => {
    k.set(review({ status: 'exceeded' }))
    await ctrl.resolveExceeded(k.kind, 'ws', 'blk_1', 'extra-round')
    expect(deps.dispatchIterationCap).toHaveBeenCalledWith(
      'ws',
      'blk_1',
      'extra-round',
      expect.objectContaining({ extraRound: expect.any(Function), proceed: expect.any(Function) }),
    )
  })

  it('requestRecommendations offloads to the durable driver when a run is parked', async () => {
    k.set(review({ status: 'ready' }))
    const parkedStep = step({
      state: 'waiting_decision',
      approval: { id: 'appr_7', status: 'pending', proposal: '' },
    })
    const inst = instance([parkedStep], { status: 'blocked' })
    deps.executionRepository.get = vi.fn(async () => inst)
    await ctrl.requestRecommendations(k.kind, 'ws', 'blk_1', ['rri_1', 'rri_2'], 'prefer X')
    // Placeholders are created synchronously; the slow Writer is offloaded, not run inline.
    expect(k.kind.prepareRecommendations).toHaveBeenCalledWith(
      'ws',
      'rrv_1',
      ['rri_1', 'rri_2'],
      'prefer X',
    )
    expect(parkedStep.pendingRecommendation).toEqual({
      itemIds: ['rri_1', 'rri_2'],
      note: 'prefer X',
    })
    expect(inst.status).toBe('running') // re-armed before signalling
    expect(deps.workRunner.signalDecision).toHaveBeenCalledWith(
      'ws',
      'exec_1',
      'appr_7',
      'recommend',
    )
    expect(k.kind.fillRecommendations).not.toHaveBeenCalled()
  })

  it('requestRecommendations runs the Writer inline when no run is parked', async () => {
    k.set(review({ status: 'ready' }))
    deps.executionRepository.get = vi.fn(async () => null)
    await ctrl.requestRecommendations(k.kind, 'ws', 'blk_1', ['rri_1'])
    expect(k.kind.prepareRecommendations).toHaveBeenCalled()
    expect(k.kind.fillRecommendations).toHaveBeenCalledWith('ws', 'blk_1')
    expect(deps.workRunner.signalDecision).not.toHaveBeenCalled()
  })

  it('requestRecommendations rejects a kind without a Writer', async () => {
    k.set(review({ status: 'ready' }))
    const noWriter = {
      ...k.kind,
      prepareRecommendations: undefined,
      fillRecommendations: undefined,
    }
    await expect(
      ctrl.requestRecommendations(noWriter as unknown as ReviewKind<FakeReview>, 'ws', 'blk_1', [
        'x',
      ]),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('reRequestRecommendation resets the recommendation and offloads to the driver', async () => {
    k.set(review({ status: 'ready' }))
    const parkedStep = step({
      state: 'waiting_decision',
      approval: { id: 'appr_8', status: 'pending', proposal: '' },
    })
    const inst = instance([parkedStep], { status: 'blocked' })
    deps.executionRepository.get = vi.fn(async () => inst)
    await ctrl.reRequestRecommendation(k.kind, 'ws', 'rrv_1', 'rec_1', 'try again')
    expect(k.kind.markRecommendationPending).toHaveBeenCalledWith(
      'ws',
      'rrv_1',
      'rec_1',
      'try again',
    )
    expect(parkedStep.pendingRecommendation).toEqual({ itemIds: [], note: 'try again' })
    expect(deps.workRunner.signalDecision).toHaveBeenCalledWith(
      'ws',
      'exec_1',
      'appr_8',
      'recommend',
    )
  })
})
