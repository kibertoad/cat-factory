import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'
import { JUDGE_SYSTEM_PROMPT } from './judge.js'
import { companionSystemPrompt } from './companion.js'
import { anchoredQualityScale, renderPriorReviewRounds } from './review-rounds.js'

// The prompt half of the companion loop's memory. `userPromptFor` is the ONE assembly both
// companion surfaces and the producer pass through, so these assert at that seam rather than at a
// per-kind prompt: a fold that only reached the inline companion would pass a narrower test.

function registry(): AgentKindRegistry {
  const reg = defaultAgentKindRegistry()
  reg.register({ kind: 'architect', systemPrompt: 'You design.' })
  reg.register({ kind: 'architect-companion', systemPrompt: 'You grade designs.' })
  reg.register({ kind: 'reviewer', systemPrompt: 'You review code.' })
  reg.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
  })
  reg.registerCompanion({
    kind: 'reviewer',
    targets: ['coder'],
    defaultThreshold: 0.8,
    reviews: 'the change',
    surface: 'container-explore',
  })
  return reg
}

const rounds = [
  {
    round: 1,
    rating: 0.72,
    passed: false,
    summary: 'pin the image tag',
    comments: [{ body: 'pathType is required' }],
  },
  { round: 2, rating: 0.77, passed: false, summary: 'runAsNonRoot needs a numeric uid' },
]

function context(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'architect-companion',
    workspaceId: 'ws1',
    executionId: 'run1',
    stepIndex: 1,
    block: { id: 'b1', title: 'Deploy the service', type: 'task' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as unknown as AgentRunContext
}

describe('the prior-rounds fold', () => {
  it('reaches a companion as its OWN verdicts, with the asks and the rope left', () => {
    const prompt = userPromptFor(
      context({ priorReview: { role: 'grader', threshold: 0.8, roundsRemaining: 1, rounds } }),
      registry(),
    )
    expect(prompt).toContain('Round 1 — rated 0.72')
    expect(prompt).toContain('Round 2 — rated 0.77')
    expect(prompt).toContain('pathType is required')
    expect(prompt).toContain('1 automatic rework round(s) remain')
    // The directive is the load-bearing half: shown a history without it, a grader still
    // re-reviews from scratch and spends the round on a fresh subset of problems.
    expect(prompt).toContain('whether it is now addressed')
  })

  it('reaches a CONTAINER-backed companion identically (one fold site, not one per surface)', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'reviewer',
        priorReview: { role: 'grader', threshold: 0.8, roundsRemaining: 0, rounds },
      }),
      registry(),
    )
    expect(prompt).toContain('Round 1 — rated 0.72')
    expect(prompt).toContain('LAST automatic round')
  })

  it('reaches the PRODUCER as points not to regress on, without the grader-only rope', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: { role: 'producer', threshold: 0.8, roundsRemaining: 1, rounds: [rounds[0]!] },
        revision: { previousProposal: 'v1', feedback: 'runAsNonRoot needs a numeric uid' },
      }),
      registry(),
    )
    expect(prompt).toContain('pin the image tag')
    expect(prompt).toContain('do not undo a fix or drop an open point')
    // A producer told how many rounds are left optimises for the grader rather than the work.
    expect(prompt).not.toContain('automatic rework round(s) remain')
    // The current round's feedback comes FIRST (it is the work); the history follows it.
    expect(prompt.indexOf('runAsNonRoot needs a numeric uid')).toBeLessThan(
      prompt.indexOf('pin the image tag'),
    )
  })

  it('adds nothing at all when there is no history', () => {
    const plain = userPromptFor(context(), registry())
    expect(plain).not.toContain('Round 1')
  })
})

describe('the anchored scale', () => {
  it('is the SAME anchor points for the judge and the companion buckets', () => {
    // An operator sets one number per policy. Two graders that mean different things by 0.8 turn
    // that number into noise, which is why the scale is one function rather than two sentences.
    const companion = companionSystemPrompt('architect-companion', registry())!
    for (const anchor of ['1.0 fully meets', '0.8 meets it with minor', '0.6 has a real gap']) {
      expect(JUDGE_SYSTEM_PROMPT).toContain(anchor)
      expect(companion).toContain(anchor)
    }
    expect(JUDGE_SYSTEM_PROMPT).toContain(anchoredQualityScale('the rubric'))
  })
})

describe('renderPriorReviewRounds', () => {
  it('trims an older round harder than the latest, and SAYS it trimmed', () => {
    // A silently shortened summary reads exactly like a grader that had little to say.
    const long = 'x'.repeat(5_000)
    const lines = renderPriorReviewRounds([
      { round: 1, rating: 0.5, passed: false, summary: long },
      { round: 2, rating: 0.6, passed: false, summary: long },
    ]).join('\n')
    expect(lines).toContain('[trimmed]')
    // The latest keeps more than the earlier one, so the asks most likely still open survive.
    const [first, second] = lines.split('Round 2')
    expect(second!.length).toBeGreaterThan(first!.length)
  })
})
