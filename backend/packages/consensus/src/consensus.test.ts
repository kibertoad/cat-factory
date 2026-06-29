import { beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutor,
  AgentRunContext,
  ConsensusSession,
  ModelProvider,
  TaskEstimate,
} from '@cat-factory/kernel'
import { decideConsensusMode } from './gating.js'
import { parseScoreMap } from './strategies/rankedVoting.js'
import { ConsensusAgentExecutor } from './ConsensusAgentExecutor.js'
import { registerConsensusTraits } from './traits.js'
import type { GenerateFn } from './strategies/types.js'

const estimate = (over: Partial<TaskEstimate> = {}): TaskEstimate => ({
  complexity: 0.5,
  risk: 0.5,
  impact: 0.5,
  rationale: 'x',
  model: null,
  createdAt: 0,
  ...over,
})

describe('decideConsensusMode', () => {
  it('runs consensus when gating is absent or disabled', () => {
    expect(decideConsensusMode(estimate({ risk: 0 }), undefined)).toBe('consensus')
    expect(
      decideConsensusMode(estimate({ risk: 0 }), {
        enabled: false,
        onMissingEstimate: 'consensus',
      }),
    ).toBe('consensus')
  })

  it('triggers when ANY supplied axis meets its threshold', () => {
    const gating = {
      enabled: true,
      minRisk: 0.7,
      minImpact: 0.9,
      onMissingEstimate: 'consensus' as const,
    }
    expect(decideConsensusMode(estimate({ risk: 0.8, impact: 0.1 }), gating)).toBe('consensus')
    expect(decideConsensusMode(estimate({ risk: 0.1, impact: 0.95 }), gating)).toBe('consensus')
    expect(decideConsensusMode(estimate({ risk: 0.1, impact: 0.1 }), gating)).toBe('standard')
  })

  it('honors onMissingEstimate when no estimate is present', () => {
    expect(
      decideConsensusMode(null, { enabled: true, minRisk: 0.5, onMissingEstimate: 'consensus' }),
    ).toBe('consensus')
    expect(
      decideConsensusMode(null, { enabled: true, minRisk: 0.5, onMissingEstimate: 'standard' }),
    ).toBe('standard')
  })

  it('falls back to standard when gating is enabled but no thresholds are set', () => {
    expect(decideConsensusMode(estimate(), { enabled: true, onMissingEstimate: 'consensus' })).toBe(
      'standard',
    )
  })
})

describe('parseScoreMap', () => {
  it('parses and clamps a label→score object embedded in prose', () => {
    const map = parseScoreMap('Here: {"Expert A": 0.8, "Expert B": 1.7, "Expert C": -1}', [
      'Expert A',
      'Expert B',
      'Expert C',
    ])
    expect(map).toEqual({ 'Expert A': 0.8, 'Expert B': 1, 'Expert C': 0 })
  })

  it('returns empty on unparseable text', () => {
    expect(parseScoreMap('no json here', ['Expert A'])).toEqual({})
  })
})

// --- Executor: delegate vs run ------------------------------------------------

const fakeProvider: ModelProvider = { resolve: () => ({}) as never }
const agentRouting = { default: { ref: { provider: 'fake', model: 'm' } }, byKind: {} }

function makeContext(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'architect',
    pipelineName: 'pl',
    workspaceId: 'ws',
    executionId: 'ex',
    stepIndex: 2,
    isFinalStep: false,
    block: { id: 'blk', title: 'T', type: 'service', description: 'D' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as AgentRunContext
}

const standard: AgentExecutor = {
  run: vi.fn(async () => ({ output: 'STANDARD', model: 'fake:m' })),
  resolveModel: vi.fn(async () => 'fake:m'),
}

// A deterministic generate: synthesizer calls answer SYNTH, participant calls answer their prompt tag.
const fakeGenerate: GenerateFn = async ({ system, prompt }) => {
  const isSynth = system.startsWith('You are a neutral synthesizer')
  return {
    text: isSynth ? 'SYNTHESIZED' : `draft:${prompt.length}`,
    usage: { inputTokens: 1, outputTokens: 1 },
  }
}

const baseDeps = {
  standard,
  modelProvider: fakeProvider,
  agentRouting,
  now: () => 0,
  generate: fakeGenerate,
}

const twoParticipants = [
  { id: 'p1', role: 'Pragmatist', systemFraming: 'simple' },
  { id: 'p2', role: 'Skeptic', systemFraming: 'risks' },
]

describe('ConsensusAgentExecutor', () => {
  // The executor only runs consensus for kinds that carry a consensus capability trait
  // (the runtime backstop for the builder's eligibility UI). `architect` is in the
  // default-eligible set, so register the traits before exercising the run path.
  beforeAll(() => {
    registerConsensusTraits()
  })

  it('delegates to the standard executor when no consensus config', async () => {
    const exec = new ConsensusAgentExecutor(baseDeps)
    const res = await exec.run(makeContext())
    expect(res.output).toBe('STANDARD')
  })

  it('delegates when gating marks the task below threshold', async () => {
    const exec = new ConsensusAgentExecutor(baseDeps)
    const res = await exec.run(
      makeContext({
        consensus: {
          enabled: true,
          strategy: 'specialist-panel',
          participants: twoParticipants,
          gating: { enabled: true, minRisk: 0.8, onMissingEstimate: 'consensus' as const },
        },
        block: {
          id: 'blk',
          title: 'T',
          type: 'service',
          description: 'D',
          estimate: estimate({ risk: 0.2, impact: 0.2, complexity: 0.2 }),
        },
      }),
    )
    expect(res.output).toBe('STANDARD')
  })

  it('delegates when the kind is not consensus-eligible, even with a full config', async () => {
    const exec = new ConsensusAgentExecutor(baseDeps)
    const res = await exec.run(
      // `coder` is a container kind that must clone/edit/commit/PR — it carries no
      // consensus trait, so a hand-crafted config must NOT divert it to an inline panel.
      makeContext({
        agentKind: 'coder',
        consensus: { enabled: true, strategy: 'specialist-panel', participants: twoParticipants },
      }),
    )
    expect(res.output).toBe('STANDARD')
    expect(
      exec.runsAsync(
        makeContext({
          agentKind: 'coder',
          consensus: { enabled: true, strategy: 'debate', participants: twoParticipants },
        }),
      ),
    ).toBe(false) // standard fake is not async
  })

  it('runs the panel, persists + emits a session, and returns the synthesis', async () => {
    const sessions: ConsensusSession[] = []
    const exec = new ConsensusAgentExecutor({
      ...baseDeps,
      sessionRepository: {
        get: async () => null,
        getByStep: async () => null,
        getByBlock: async () => null,
        upsert: async (_ws, s) => {
          sessions.push(structuredClone(s))
        },
      },
      eventPublisher: { executionChanged: async () => {}, boardChanged: async () => {} },
    })
    const res = await exec.run(
      makeContext({
        consensus: {
          enabled: true,
          strategy: 'specialist-panel',
          participants: twoParticipants,
        },
      }),
    )
    expect(res.output).toBe('SYNTHESIZED')
    expect(res.model).toContain('consensus:specialist-panel')
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 3 }) // 2 drafts + 1 synth
    const last = sessions.at(-1)!
    expect(last.status).toBe('done')
    expect(last.strategy).toBe('specialist-panel')
    expect(last.rounds[0]?.contributions).toHaveLength(2)
    expect(last.synthesis).toBe('SYNTHESIZED')
    expect(last.id).toBe('cns_ex_2')
  })

  it('runsAsync is false while consensus is active, delegated otherwise', () => {
    const exec = new ConsensusAgentExecutor(baseDeps)
    expect(
      exec.runsAsync(
        makeContext({
          consensus: { enabled: true, strategy: 'debate', participants: twoParticipants },
        }),
      ),
    ).toBe(false)
    // No consensus → forwards to standard (not async) → false
    expect(exec.runsAsync(makeContext())).toBe(false)
  })
})
