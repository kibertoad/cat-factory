import { describe, expect, it } from 'vitest'
import type {
  ForkDecisionStepState,
  ForkProposal,
  PipelineStep,
  StepGating,
  TaskEstimate,
} from '@cat-factory/kernel'
import {
  buildImplementationChoice,
  forkChatBudgetSpent,
  forkPhasePending,
  humanChatTurns,
  mintForks,
  resolveForkTriState,
  shouldProposeForkAuto,
  usableForks,
} from './forkDecision.logic.js'

const estimate = (complexity: number, risk: number, impact: number): TaskEstimate => ({
  complexity,
  risk,
  impact,
  rationale: '',
  createdAt: 0,
})

const coderStep = (forkDecision?: PipelineStep['forkDecision']): PipelineStep =>
  ({ agentKind: 'coder', state: 'working', forkDecision }) as unknown as PipelineStep

const proposal = (over: Partial<ForkProposal> = {}): ForkProposal => ({
  seamSummary: 'the mapper seam',
  forks: [
    {
      title: 'Patch the call site',
      summary: 's1',
      approach: 'a1',
      tradeoffs: ['t'],
      recommended: true,
    },
    { title: 'Refactor the seam', summary: 's2', approach: 'a2', tradeoffs: ['t'] },
  ],
  singlePath: false,
  singlePathReason: null,
  ...over,
})

describe('resolveForkTriState', () => {
  it('defaults to auto and honours explicit values', () => {
    expect(resolveForkTriState(undefined)).toBe('auto')
    expect(resolveForkTriState({})).toBe('auto')
    expect(resolveForkTriState({ 'coder.forkDecision': 'always' })).toBe('always')
    expect(resolveForkTriState({ 'coder.forkDecision': 'off' })).toBe('off')
    // Unknown value falls back to auto (lenient, like resolveAgentConfigValue).
    expect(resolveForkTriState({ 'coder.forkDecision': 'bogus' })).toBe('auto')
  })
})

describe('shouldProposeForkAuto', () => {
  it('is off when the gating group is absent or disabled', () => {
    expect(shouldProposeForkAuto(undefined, estimate(1, 1, 1))).toBe(false)
    expect(shouldProposeForkAuto(null, estimate(1, 1, 1))).toBe(false)
    expect(
      shouldProposeForkAuto(
        { enabled: false, minRisk: 0.1, onMissingEstimate: 'run' },
        estimate(1, 1, 1),
      ),
    ).toBe(false)
  })

  it('when enabled, proposes iff ANY supplied axis meets its threshold', () => {
    const gating: StepGating = { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' }
    expect(shouldProposeForkAuto(gating, estimate(0.1, 0.7, 0.1))).toBe(true)
    expect(shouldProposeForkAuto(gating, estimate(0.9, 0.1, 0.9))).toBe(false) // only risk gated
  })

  it('when enabled with no estimate, falls back to onMissingEstimate', () => {
    expect(
      shouldProposeForkAuto({ enabled: true, minRisk: 0.6, onMissingEstimate: 'run' }, null),
    ).toBe(true)
    expect(
      shouldProposeForkAuto({ enabled: true, minRisk: 0.6, onMissingEstimate: 'skip' }, undefined),
    ).toBe(false)
  })
})

describe('forkPhasePending', () => {
  it('claims a fresh coder step unless the tri-state is off', () => {
    expect(forkPhasePending(coderStep(), 'auto')).toBe(true)
    expect(forkPhasePending(coderStep(), 'always')).toBe(true)
    expect(forkPhasePending(coderStep(), 'off')).toBe(false)
  })

  it('does not claim a non-coder step', () => {
    const architect = { agentKind: 'architect', state: 'working' } as unknown as PipelineStep
    expect(forkPhasePending(architect, 'always')).toBe(false)
  })

  it('stops claiming once the phase is resolved', () => {
    for (const status of ['chosen', 'single_path', 'skipped'] as const) {
      expect(
        forkPhasePending(coderStep({ status, forks: [], chat: [], maxChatTurns: 15 }), 'always'),
      ).toBe(false)
    }
    // Still claims while proposing / awaiting_choice (the run-lifecycle guard handles the park).
    expect(
      forkPhasePending(
        coderStep({ status: 'proposing', forks: [], chat: [], maxChatTurns: 15 }),
        'always',
      ),
    ).toBe(true)
  })
})

describe('usableForks', () => {
  it('drops forks missing a title or an approach', () => {
    const p = proposal({
      forks: [
        { title: 'Real', summary: '', approach: 'do it', tradeoffs: [] },
        { title: '', summary: '', approach: 'no title', tradeoffs: [] },
        { title: 'No approach', summary: '', approach: '   ', tradeoffs: [] },
      ],
    })
    expect(usableForks(p)).toHaveLength(1)
    expect(usableForks(p)[0]!.title).toBe('Real')
  })
})

describe('mintForks', () => {
  it('assigns ids and marks exactly one recommended (the proposer pick)', () => {
    let n = 0
    const minted = mintForks(proposal().forks, () => `fork_${n++}`)
    expect(minted.map((f) => f.id)).toEqual(['fork_0', 'fork_1'])
    expect(minted.filter((f) => f.recommended)).toHaveLength(1)
    expect(minted.find((f) => f.recommended)!.title).toBe('Patch the call site')
  })

  it('defaults the recommendation to the first fork when the proposer marked none', () => {
    const minted = mintForks(
      proposal({ forks: proposal().forks.map((f) => ({ ...f, recommended: false })) }).forks,
      () => 'fork_x',
    )
    expect(minted[0]!.recommended).toBe(true)
    expect(minted[1]!.recommended).toBe(false)
  })
})

describe('fork chat budget', () => {
  const msg = (role: 'human' | 'assistant', i: number) => ({
    id: `m${i}`,
    role,
    text: 't',
    createdAt: i,
  })

  it('counts only human turns', () => {
    expect(humanChatTurns(undefined)).toBe(0)
    expect(humanChatTurns([])).toBe(0)
    expect(
      humanChatTurns([msg('human', 0), msg('assistant', 1), msg('human', 2), msg('assistant', 3)]),
    ).toBe(2)
  })

  it('is spent once the human has sent maxChatTurns messages', () => {
    const stateWith = (turns: number, max: number): ForkDecisionStepState => ({
      status: 'awaiting_choice',
      forks: [],
      chat: Array.from({ length: turns }, (_, i) => msg('human', i)),
      maxChatTurns: max,
    })
    expect(forkChatBudgetSpent(stateWith(1, 3))).toBe(false)
    expect(forkChatBudgetSpent(stateWith(3, 3))).toBe(true)
    expect(forkChatBudgetSpent(stateWith(4, 3))).toBe(true)
    // Falls back to the default cap when maxChatTurns is absent.
    expect(forkChatBudgetSpent({ status: 'awaiting_choice', forks: [], chat: [] })).toBe(false)
  })
})

describe('buildImplementationChoice', () => {
  const state = (chosen: ForkDecisionStepState['chosen']): ForkDecisionStepState => ({
    status: 'chosen',
    forks: [
      {
        id: 'fork_0',
        title: 'Patch',
        summary: '',
        approach: 'patch it',
        tradeoffs: [],
        recommended: true,
      },
      { id: 'fork_1', title: 'Refactor', summary: '', approach: 'refactor it', tradeoffs: [] },
    ],
    chat: [],
    maxChatTurns: 15,
    chosen,
  })

  it('returns undefined when nothing was chosen', () => {
    expect(buildImplementationChoice(undefined)).toBeUndefined()
    expect(buildImplementationChoice(state(null))).toBeUndefined()
  })

  it('resolves a picked fork with the rejected alternatives named', () => {
    const choice = buildImplementationChoice(state({ forkId: 'fork_0', note: 'go fast', at: 1 }))
    expect(choice).toEqual({
      source: 'proposed',
      title: 'Patch',
      approach: 'patch it',
      note: 'go fast',
      alternativesConsidered: ['Refactor'],
    })
  })

  it('treats a custom approach as source custom, listing all proposed forks as alternatives', () => {
    const choice = buildImplementationChoice(state({ custom: 'do my own thing', at: 1 }))
    expect(choice).toEqual({
      source: 'custom',
      title: 'Custom approach',
      approach: 'do my own thing',
      alternativesConsidered: ['Patch', 'Refactor'],
    })
  })

  it('returns undefined when the picked fork id no longer exists', () => {
    expect(buildImplementationChoice(state({ forkId: 'gone', at: 1 }))).toBeUndefined()
  })
})
