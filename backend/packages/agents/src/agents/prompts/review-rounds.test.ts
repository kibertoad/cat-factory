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
        revision: {
          previousProposal: 'v1',
          feedback: 'runAsNonRoot needs a numeric uid',
          requestedBy: 'reviewer',
        },
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

describe('feedback accounting', () => {
  // A producer told only to "address the feedback" silently drops what it disagrees with, and the
  // reviewer cannot tell that from a point that was missed. Both sides of that get a directive.

  it('makes the PRODUCER account for every point, including the ones it rejects', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        revision: {
          previousProposal: 'v1',
          feedback: 'commit to an ingress class',
          requestedBy: 'reviewer',
        },
      }),
      registry(),
    )
    expect(prompt).toContain('Account for EVERY point raised')
    // Disagreement needs a channel, or the only compliant move is to obey every point.
    expect(prompt).toContain('leave the work as it is')
    expect(prompt).toContain('"Response to review"')
  })

  it('puts the accounting in the REPLY, never in the artifact the producer commits', () => {
    // ONE directive reaches every producer, including the ones whose deliverable is committed:
    // `doc-writer` ships a document and `spec-writer` its `spec/` shards, and nothing strips a
    // "Response to review" section back out of either — told to answer IN the deliverable, they
    // ship it carrying a dialogue with an automated reviewer, one section per round. The reply is
    // where correspondence belongs, and it is what every companion reads anyway (the engine folds
    // a settled step's output into the next prompt as prior work).
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        revision: {
          previousProposal: 'v1',
          feedback: 'name the audience',
          requestedBy: 'reviewer',
        },
      }),
      registry(),
    )
    expect(prompt).toContain('in your REPLY')
    expect(prompt).toContain('never commit it into the work itself')
  })

  it('names WHO asked: an automatic reviewer round is not a person waiting', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        revision: { previousProposal: 'v1', feedback: 'f', requestedBy: 'reviewer' },
      }),
      registry(),
    )
    expect(prompt).toContain('An automated reviewer graded your previous proposal')
    expect(prompt).not.toContain('A person reviewed')
  })

  it('still says a PERSON asked when one actually did, which outranks the feedback itself', () => {
    // The human "request changes" path on a companion's gate redirects onto the producer's
    // `rework`, so both loops arrive through the same slice and only `requestedBy` tells them
    // apart. Flattening them loses the fact that somebody is waiting on this round.
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        revision: { previousProposal: 'v1', feedback: 'f', requestedBy: 'human' },
      }),
      registry(),
    )
    expect(prompt).toContain('A person reviewed your previous proposal')
    expect(prompt).not.toContain('An automated reviewer')
  })

  it('tells the GRADER to check the accounting against the work, once rounds exist', () => {
    const prompt = userPromptFor(
      context({ priorReview: { role: 'grader', threshold: 0.8, roundsRemaining: 1, rounds } }),
      registry(),
    )
    expect(prompt).toContain('confirm a claimed change by finding it')
    expect(prompt).toContain('settled on the argument')
    // A producer whose deliverable is a pushed commit answers with the change alone, so a missing
    // accounting must not become a finding of its own — that would spend a rework round on prose.
    expect(prompt).toContain('a missing accounting is not a finding')
  })

  it('withholds the grader directive on the FIRST grading, where no accounting can exist yet', () => {
    const plain = userPromptFor(context(), registry())
    expect(plain).not.toContain('confirm a claimed change by finding it')
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

  it('labels each point with its grade and puts the worst first', () => {
    // A round's history is what tells the next pass which of its earlier asks are still holding the
    // run. Rendered as undifferentiated bullets, the must-fix from round 1 competes for attention
    // with the nit raised in the same breath, and both sides of the loop re-triage from scratch.
    const lines = renderPriorReviewRounds([
      {
        round: 1,
        rating: 0.6,
        passed: false,
        summary: 'mostly sound',
        comments: [
          { body: 'rename this', severity: 'minor' },
          { body: 'a person said so' },
          { body: 'unhandled partial write', severity: 'blocker' },
          { body: 'thin coverage', severity: 'major' },
        ],
      },
    ])
    const bullets = lines.filter((line) => line.startsWith('- '))
    expect(bullets).toEqual([
      '- [blocker] unhandled partial write',
      '- [major] thin coverage',
      '- [minor] rename this',
      // A human's comment has no grade, so it carries no label rather than a guessed one.
      '- a person said so',
    ])
  })

  it('names an anchored point by its item id rather than as an empty quote', () => {
    // A companion anchors to a structured item and quotes nothing, so the quote is the WRONG half to
    // render it by: the two anchors are alternatives, not a preferred one plus a fallback.
    const lines = renderPriorReviewRounds([
      {
        round: 1,
        rating: 0.6,
        passed: false,
        summary: 'mostly sound',
        comments: [{ anchorId: 'AC-2', severity: 'major', body: 'still open' }],
      },
    ])
    expect(lines.filter((line) => line.startsWith('- '))).toEqual([
      '- [major] On item `AC-2`: still open',
    ])
  })
})

describe('the points a producer is sent back with', () => {
  const revised = (comments: NonNullable<AgentRunContext['revision']>['comments']) =>
    userPromptFor(
      context({
        agentKind: 'architect',
        revision: {
          previousProposal: 'v1',
          feedback: 'the design needs another pass',
          requestedBy: 'reviewer',
          comments,
        },
      }),
      registry(),
    )

  it('names the item an ANCHOR-ONLY point targets, which is every companion finding', () => {
    // The shape every shipped companion prompt asks for is `{anchorId, severity, body}` with no
    // quoted source. Rendered against the quote alone, each of those became `On this part:` over a
    // literal `(empty)` — a `[blocker]` the producer is ordered to resolve first, pointing nowhere.
    const prompt = revised([
      { anchorId: 'REQ-4', severity: 'blocker', body: 'the retry path is unhandled' },
    ])
    expect(prompt).toContain('On item `REQ-4`: [blocker]')
    expect(prompt).not.toContain('(empty)')
    expect(prompt).toContain('Every comment marked [blocker] MUST be resolved')
  })

  it('keeps a QUOTED point on its own line, since it is verbatim source of any length', () => {
    const prompt = revised([{ quotedSource: '## Rollout\nflip the flag', body: 'name the owner' }])
    expect(prompt).toContain('On this part:\n## Rollout\nflip the flag')
  })

  it('addresses a point that anchors NEITHER way to the proposal as a whole', () => {
    const prompt = revised([{ severity: 'major', body: 'no failure modes anywhere' }])
    expect(prompt).toContain('On your proposal overall: [major]')
  })

  it('orders worst first and says nothing about blockers when there are none', () => {
    const prompt = revised([
      { body: 'rename this', severity: 'minor' },
      { body: 'thin coverage', severity: 'major' },
    ])
    expect(prompt.indexOf('thin coverage')).toBeLessThan(prompt.indexOf('rename this'))
    expect(prompt).not.toContain('MUST be resolved in this revision')
  })
})
