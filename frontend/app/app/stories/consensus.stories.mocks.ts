// The board's consensus groups: reusable review panels of several models that a pipeline step can
// escalate to. The groups are made up.
import type { ConsensusGroup } from '@cat-factory/contracts'

/** One consensus group: a panel of two models, run on a task estimated as risky. */
export function consensusGroup(
  overrides: Partial<ConsensusGroup> & Pick<ConsensusGroup, 'id' | 'name'>,
) {
  return {
    strategy: 'specialist-panel',
    participants: [
      { id: 'cnp_pragmatist', role: 'Pragmatist', modelId: 'kimi-k2.7' },
      { id: 'cnp_skeptic', role: 'Skeptic', modelId: 'claude-opus' },
    ],
    gating: { enabled: true, minRisk: 0.7, onMissingEstimate: 'consensus' },
    createdAt: Date.UTC(2026, 8, 15),
    ...overrides,
  } satisfies ConsensusGroup
}

/** The board's library: a panel for risky changes and an ungated architecture debate. */
export const consensusGroups: ConsensusGroup[] = [
  consensusGroup({
    id: 'cg_risky',
    name: 'Risky changes',
    description: 'Two models check any change estimated as risky.',
  }),
  consensusGroup({
    id: 'cg_debate',
    name: 'Architecture debate',
    strategy: 'debate',
    rounds: 3,
    participants: [
      { id: 'cnp_a', role: 'Proposer', modelId: 'claude-opus' },
      { id: 'cnp_b', role: 'Critic', modelId: 'kimi-k2.7' },
      { id: 'cnp_c', role: 'Operator', systemFraming: 'Think about running it at 3 a.m.' },
    ],
    synthesizerModelId: 'claude-opus',
    gating: { enabled: false, onMissingEstimate: 'consensus' },
    createdAt: Date.UTC(2026, 9, 2),
  }),
]
