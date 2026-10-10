import { describe, expect, it, vi } from 'vitest'
import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { BinaryCandidateController } from './BinaryCandidateController.js'

// The three DISPOSITIONS of a settled candidate pass, and the refusals that guard the human's
// keep. Everything here is pure state transition over an in-memory instance, so it needs neither
// a database nor a driver: the collaborators are stubs that record what was asked of them.

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'imager',
    state: 'running',
    stepOptions: { binaryOutput: { storageServiceId: 'asset-store', comparison: {} } },
    ...overrides,
  } as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    status: 'running',
    currentStep: 0,
    steps,
  } as ExecutionInstance
}

function controller(overrides: Record<string, unknown> = {}) {
  const parked: string[] = []
  const persisted: string[] = []
  const deps = {
    blockRepository: { get: async () => ({ id: 'task_1', title: 'Sprites' }) },
    executionRepository: { get: async () => null },
    workRunner: { signalDecision: vi.fn(async () => {}) },
    stateMachine: {
      parkStepOnDecision: async () => {
        parked.push('parked')
        return { kind: 'park' as const }
      },
      persistAndEmit: async () => void persisted.push('persisted'),
      mutateInstance: vi.fn(),
      clearWaitingNotification: vi.fn(async () => {}),
      updateBlockProgress: vi.fn(async () => {}),
      emitInstance: vi.fn(async () => {}),
    },
    stepGraph: { resetStepForRerun: vi.fn(), startStep: vi.fn() },
    idGenerator: {
      next: (() => {
        let n = 0
        return () => `cand_${++n}`
      })(),
    },
    clock: { now: () => 1 },
    notificationService: { raise: vi.fn(async () => {}) },
    ...overrides,
  }
  // The deps object is deliberately structural rather than fully typed: the controller reads a
  // handful of methods off each collaborator, and a full fake of every engine port would test the
  // fakes rather than the dispositions.
  return {
    controller: new BinaryCandidateController(deps as never),
    deps,
    parked,
    persisted,
  }
}

function reply(entries: unknown[]): string {
  return ['done', '', '```binary-candidates', JSON.stringify(entries), '```'].join('\n')
}

const two = [
  { service: 'asset-store', location: 'staging/a.png', generator: 'flux', subject: 'anvil' },
  { service: 'asset-store', location: 'staging/b.png', generator: 'retro', subject: 'anvil' },
]

describe('recordCandidates', () => {
  it('parks when there is something to compare', async () => {
    const { controller: c, parked, deps } = controller()
    const s = step()
    const result = await c.recordCandidates('ws', instance([s]), s, reply(two))
    expect(result).toEqual({ kind: 'park' })
    expect(parked).toHaveLength(1)
    expect(s.binaryCandidates?.status).toBe('awaiting_choice')
    expect(s.binaryCandidates?.candidates).toHaveLength(2)
    // The card the inbox shows names WHICH decision is waiting; the park's own generic card is
    // non-clobbering, so this one wins.
    expect(deps.notificationService.raise).toHaveBeenCalled()
  })

  // Nobody is asked to choose between one thing. Discarding a real generation because it had no
  // rival would be the worse outcome, so the only candidate is kept and the record SAYS nobody
  // reviewed it.
  it('keeps the only candidate automatically and re-arms the step', async () => {
    const { controller: c, deps, parked } = controller()
    const s = step()
    const result = await c.recordCandidates('ws', instance([s]), s, reply([two[0]]))
    expect(result).toEqual({ kind: 'continue' })
    expect(parked).toEqual([])
    expect(s.binaryCandidates?.status).toBe('chosen')
    expect(s.binaryCandidates?.choice?.automatic).toBe(true)
    expect(deps.stepGraph.resetStepForRerun).toHaveBeenCalledWith(s)
    expect(deps.stepGraph.startStep).toHaveBeenCalledWith(s)
  })

  // A comparison that wedged a run because a model forgot a fenced block would be a worse failure
  // than the one it exists to prevent. Each empty cause keeps its own reason on the step.
  it.each([
    ['undeclared', 'no block at all'],
    ['parse_failed', ['x', '```binary-candidates', '{oops', '```'].join('\n')],
    ['no_candidates', ['x', '```binary-candidates', 'none', '```'].join('\n')],
  ])('records %s and falls through to the ordinary completion', async (reason, output) => {
    const { controller: c, parked } = controller()
    const s = step()
    const result = await c.recordCandidates('ws', instance([s]), s, output)
    expect(result).toBeNull()
    expect(parked).toEqual([])
    expect(s.binaryCandidates).toMatchObject({ status: 'no_choice', noChoiceReason: reason })
  })

  it('freezes the multi-select rule onto the state it parks with', async () => {
    const { controller: c } = controller()
    const s = step({
      stepOptions: {
        binaryOutput: { storageServiceId: 'asset-store', comparison: { multiSelect: true } },
      },
    } as Partial<PipelineStep>)
    await c.recordCandidates('ws', instance([s]), s, reply(two))
    expect(s.binaryCandidates?.multiSelect).toBe(true)
  })
})

describe('keep', () => {
  /** Drive `keep` against an in-memory parked instance, returning the mutated step. */
  async function keepOn(
    input: Parameters<BinaryCandidateController['keep']>[2],
    stateOverrides: Record<string, unknown> = {},
  ) {
    const parked = step({
      state: 'waiting_decision',
      approval: { id: 'apr_1', status: 'pending' },
      binaryCandidates: {
        status: 'awaiting_choice',
        multiSelect: false,
        invalidEntries: 0,
        omitted: 0,
        unusablePreviews: 0,
        candidates: [
          { id: 'cand_1', service: 'asset-store', location: 'staging/a.png' },
          { id: 'cand_2', service: 'asset-store', location: 'staging/b.png' },
        ],
        ...stateOverrides,
      },
    } as Partial<PipelineStep>)
    const inst = instance([parked])
    const { controller: c, deps } = controller({
      stateMachine: {
        parkStepOnDecision: async () => ({ kind: 'park' as const }),
        persistAndEmit: async () => {},
        mutateInstance: async (
          _ws: string,
          _id: string,
          mutate: (i: ExecutionInstance) => void,
        ) => {
          mutate(inst)
          return inst
        },
        clearWaitingNotification: vi.fn(async () => {}),
        updateBlockProgress: vi.fn(async () => {}),
        emitInstance: vi.fn(async () => {}),
      },
    })
    await c.keep('ws', 'exec_1', input)
    return { step: parked, deps }
  }

  it('records what survives, what does not, and re-arms the step', async () => {
    const { step: s, deps } = await keepOn({ keep: [{ candidateId: 'cand_2' }] })
    expect(s.binaryCandidates?.status).toBe('chosen')
    expect(s.binaryCandidates?.choice?.kept).toEqual([{ candidateId: 'cand_2' }])
    // Recorded explicitly rather than derived later: the delivering pass is what clears the
    // staged files, and it needs the list.
    expect(s.binaryCandidates?.choice?.discarded).toEqual(['cand_1'])
    expect(s.binaryCandidates?.choice?.automatic).toBeUndefined()
    expect(deps.workRunner.signalDecision).toHaveBeenCalledWith('ws', 'exec_1', 'apr_1', 'approved')
  })

  it('refuses an id the step never staged', async () => {
    await expect(keepOn({ keep: [{ candidateId: 'cand_9' }] })).rejects.toThrow(/Unknown candidate/)
  })

  it('refuses a second candidate on a single-select step', async () => {
    await expect(
      keepOn({ keep: [{ candidateId: 'cand_1' }, { candidateId: 'cand_2' }] }),
    ).rejects.toThrow(/keeps one candidate/)
  })

  // Two survivors at one address is one artifact, so the alternate id is what makes keeping two a
  // real outcome. Both ways of losing it are refused where they can be fixed.
  it('refuses two survivors that would land under the same name', async () => {
    await expect(
      keepOn(
        { keep: [{ candidateId: 'cand_1' }, { candidateId: 'cand_2' }] },
        { multiSelect: true },
      ),
    ).rejects.toThrow(/requires an id for each/)
    await expect(
      keepOn(
        {
          keep: [
            { candidateId: 'cand_1', storeAs: 'anvil' },
            { candidateId: 'cand_2', storeAs: 'anvil' },
          ],
        },
        { multiSelect: true },
      ),
    ).rejects.toThrow(/DISTINCT id/)
  })

  it('keeps two under distinct ids when the step allows it', async () => {
    const { step: s } = await keepOn(
      {
        keep: [
          { candidateId: 'cand_1', storeAs: 'anvil-photo' },
          { candidateId: 'cand_2', storeAs: 'anvil-pixel' },
        ],
      },
      { multiSelect: true },
    )
    expect(s.binaryCandidates?.choice?.kept).toEqual([
      { candidateId: 'cand_1', storeAs: 'anvil-photo' },
      { candidateId: 'cand_2', storeAs: 'anvil-pixel' },
    ])
    expect(s.binaryCandidates?.choice?.discarded).toEqual([])
  })
})
