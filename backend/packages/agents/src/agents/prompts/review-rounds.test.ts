import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'
import { JUDGE_SYSTEM_PROMPT } from './judge.js'
import { companionSystemPrompt } from './companion.js'
import {
  anchoredQualityScale,
  renderOpenFindings,
  renderPriorReviewRounds,
} from './review-rounds.js'

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
  it('reaches a companion as its OWN verdicts', () => {
    const prompt = userPromptFor(
      context({ priorReview: { role: 'grader', threshold: 0.8, rounds } }),
      registry(),
    )
    expect(prompt).toContain('Round 1 — rated 0.72')
    expect(prompt).toContain('Round 2 — rated 0.77')
    expect(prompt).toContain('pathType is required')
    // The directive is the load-bearing half: shown a history without it, a grader still
    // re-reviews from scratch and spends the round on a fresh subset of problems.
    expect(prompt).toContain('whether it is now addressed')
  })

  it('reaches a CONTAINER-backed companion identically (one fold site, not one per surface)', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'reviewer',
        priorReview: { role: 'grader', threshold: 0.8, rounds },
      }),
      registry(),
    )
    expect(prompt).toContain('Round 1 — rated 0.72')
  })

  it('reaches the PRODUCER as points not to regress on, without the grader-only rope', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: { role: 'producer', threshold: 0.8, rounds: [rounds[0]!] },
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
      context({ priorReview: { role: 'grader', threshold: 0.8, rounds } }),
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
    const lines = renderPriorReviewRounds(
      [
        { round: 1, rating: 0.5, passed: false, summary: long },
        { round: 2, rating: 0.6, passed: false, summary: long },
      ],
      0.8,
    ).join('\n')
    expect(lines).toContain('[trimmed]')
    // The latest keeps more than the earlier one, so the asks most likely still open survive.
    const [first, second] = lines.split('Round 2')
    expect(second!.length).toBeGreaterThan(first!.length)
  })

  it('labels each point with its grade and puts the worst first', () => {
    // A round's history is what tells the next pass which of its earlier asks are still holding the
    // run. Rendered as undifferentiated bullets, the must-fix from round 1 competes for attention
    // with the nit raised in the same breath, and both sides of the loop re-triage from scratch.
    const lines = renderPriorReviewRounds(
      [
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
      ],
      0.8,
    )
    const bullets = lines.filter((line) => line.startsWith('- '))
    expect(bullets).toEqual([
      '- [blocker] unhandled partial write',
      '- [major] thin coverage',
      '- [minor] rename this',
      // A human's comment has no grade, so it carries no label rather than a guessed one.
      '- a person said so',
    ])
  })

  it('states the bar comparison and the disposition as separate facts', () => {
    // `passed` is the ENGINE's disposition, not `rating >= threshold`: a blocker holds a round
    // whatever it scored, and the first batch beyond a nit is force-looped even from a producer
    // that scored well. Rendered as "did not meet the bar" against a bar the same prompt states,
    // one of the two numbers has to be wrong, and a grader spent a round saying so.
    const held = renderPriorReviewRounds(
      [
        {
          round: 1,
          rating: 0.86,
          passed: false,
          summary: 'good, one must-fix',
          comments: [{ body: 'unhandled partial write', severity: 'blocker' }],
        },
      ],
      0.8,
    ).join('\n')
    expect(held).toContain(
      'rated 0.86, which met the bar, but a [blocker] below held the work back',
    )
    expect(held).not.toContain('did not meet the bar')

    // Same shape, no blocker: the first batch was force-looped, which is a different cause and
    // reads as one.
    const looped = renderPriorReviewRounds(
      [
        {
          round: 1,
          rating: 0.9,
          passed: false,
          summary: 'a few majors',
          comments: [{ body: 'x', severity: 'major' }],
        },
      ],
      0.8,
    ).join('\n')
    expect(looped).toContain(
      'which met the bar, and was still sent back once over the findings below',
    )

    // And a round that really was under the bar still says so plainly.
    const below = renderPriorReviewRounds(
      [{ round: 1, rating: 0.72, passed: false, summary: 'not there yet' }],
      0.8,
    ).join('\n')
    expect(below).toContain('rated 0.72, below the bar')
  })

  it('never renders a disposition as a bar comparison, in either direction', () => {
    // The failing side of this was the reported bug: `passed` is the ENGINE's disposition, so
    // rendering it as "did not meet the bar" put two numbers in one prompt that contradicted each
    // other. The PASSING side is the same conflation mirror-imaged, and it was still there: a round
    // the engine advanced on a rating below the threshold read as having met a bar it did not meet.
    const passedBelow = renderPriorReviewRounds(
      [{ round: 1, rating: 0.42, passed: true, summary: 'advanced anyway' }],
      0.8,
    ).join('\n')
    expect(passedBelow).toContain('rated 0.42, which was below the bar and was passed anyway')
    expect(passedBelow).not.toContain('which met the bar')
    // And the ordinary case still reads as it should.
    const passedAbove = renderPriorReviewRounds(
      [{ round: 1, rating: 0.91, passed: true, summary: 'good' }],
      0.8,
    ).join('\n')
    expect(passedAbove).toContain('rated 0.91, which met the bar')
  })

  it('keeps the threshold NUMBER out of the wording, for the producer as much as the grader', () => {
    // The bar is told to the grader once, in the heading above the rounds, for the same reason the
    // rope left is: a producer handed the number optimises for it rather than for the work.
    const lines = renderPriorReviewRounds(
      [{ round: 1, rating: 0.72, passed: false, summary: 'not there yet' }],
      0.8,
    ).join('\n')
    expect(lines).not.toContain('0.80')
  })

  it('names an anchored point by its item id rather than as an empty quote', () => {
    // A companion anchors to a structured item and quotes nothing, so the quote is the WRONG half to
    // render it by: the two anchors are alternatives, not a preferred one plus a fallback.
    const lines = renderPriorReviewRounds(
      [
        {
          round: 1,
          rating: 0.6,
          passed: false,
          summary: 'mostly sound',
          comments: [{ anchorId: 'AC-2', severity: 'major', body: 'still open' }],
        },
      ],
      0.8,
    )
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

describe('the grading bar', () => {
  // The defect this covers: the bar used to be a clause inside the prior-rounds heading, and
  // `priorReview` is absent on the FIRST grading of a step. So the very first verdict of every
  // companion loop was a 0..1 rating against a threshold nobody had stated, and the number only
  // appeared from round two.

  it('reaches a grader on the FIRST round, where there is no history at all', () => {
    const prompt = userPromptFor(
      context({ gradingBar: { threshold: 0.8, roundsRemaining: 2 } }),
      registry(),
    )
    expect(prompt).toContain('The bar for this work is 0.80')
    expect(prompt).toContain('2 automatic rework round(s) remain')
    expect(prompt).not.toContain('Round 1')
  })

  it('says so when it is holding the LAST round, so a marginal call is made knowingly', () => {
    const prompt = userPromptFor(
      context({
        gradingBar: { threshold: 0.8, roundsRemaining: 0 },
        priorReview: { role: 'grader', threshold: 0.8, rounds },
      }),
      registry(),
    )
    expect(prompt).toContain('LAST automatic round')
  })

  it('is stated ONCE, not once per section', () => {
    const prompt = userPromptFor(
      context({
        gradingBar: { threshold: 0.8, roundsRemaining: 1 },
        priorReview: { role: 'grader', threshold: 0.8, rounds },
      }),
      registry(),
    )
    expect(prompt.split('The bar for this work is').length - 1).toBe(1)
  })

  it('is never shown to the PRODUCER, which would optimise for the number', () => {
    // The producer still gets the per-round bar COMPARISON, which is the part about its own work.
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: { role: 'producer', threshold: 0.8, rounds: [rounds[0]!] },
        revision: { previousProposal: 'v1', feedback: 'f', requestedBy: 'reviewer' },
      }),
      registry(),
    )
    expect(prompt).not.toContain('The bar for this work is')
    expect(prompt).not.toContain('automatic rework round(s) remain')
    expect(prompt).toContain('below the bar')
  })

  it('carries the number ONCE, leaving the shared rating rule to the system prompt', () => {
    // Both ride every companion grading dispatch, so a rule restated in each is the same paragraph
    // twice in one prompt. The wrapper owns the per-step number and the rope; how a rating and a
    // blocker are read against each other, and the instruction not to steer the number, are the
    // system prompt's, which is a per-kind constant and states them for free.
    const system = companionSystemPrompt('architect-companion', registry())!
    expect(system).toContain('THE TWO ARE READ SEPARATELY')
    expect(system).toContain('rather than lowering the rating to force a fix')
    const prompt = userPromptFor(
      context({
        agentKind: 'architect-companion',
        gradingBar: { threshold: 0.8, roundsRemaining: 2 },
      }),
      registry(),
    )
    expect(prompt).toContain('The bar for this work is 0.80')
    expect(prompt).not.toContain('rather than steering the number')
  })

  it('states no location for the bar, so a surface that renders none has nothing dangling', () => {
    // The editor measuring what the platform appends, and the Sandbox composing a graded candidate,
    // both compose this system prompt with no companion loop to read a bar off. A sentence here
    // promising the number "below" would be a pointer at nothing on exactly those surfaces.
    const system = companionSystemPrompt('architect-companion', registry())!
    expect(system).not.toContain('stated with the work below')
    expect(system).not.toContain('with the work below')
  })
})

describe('deduplicating the producer history against the current round', () => {
  // A point still open is re-raised every round by design, so it arrived once as the current
  // round's ask and again in the history: on a real run "the same six points appear three times",
  // with no single authoritative list to work through.

  const anchored = (anchorId: string, body: string) => ({ anchorId, body })

  it('folds a point out of the history when the current round already lists it', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: {
          role: 'producer',
          threshold: 0.8,
          rounds: [
            {
              round: 1,
              rating: 0.6,
              passed: false,
              summary: 'first pass',
              comments: [
                anchored('r-1', 'pin the image tag'),
                anchored('r-2', 'drop the wildcard'),
              ],
            },
          ],
        },
        revision: {
          previousProposal: 'v1',
          feedback: 'still open',
          requestedBy: 'reviewer',
          comments: [anchored('r-1', 'pin the image tag')],
        },
      }),
      registry(),
    )
    // `r-1` is in the current list once and nowhere else; `r-2` was NOT re-raised, so the history
    // is the only place it survives and dropping it would lose an open point silently.
    expect(prompt.split('pin the image tag').length - 1).toBe(1)
    expect(prompt).toContain('drop the wildcard')
    // The fold is counted rather than silent: a round whose every point moved into the current
    // list would otherwise read as a round that raised nothing.
    expect(prompt).toContain('1 point(s) raised in this round are still open')
  })

  it('keeps two DIFFERENT points on the SAME anchor apart', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: {
          role: 'producer',
          threshold: 0.8,
          rounds: [
            {
              round: 1,
              rating: 0.6,
              passed: false,
              summary: 's',
              comments: [
                anchored('r-1', 'the image tag is mutable'),
                anchored('r-1', 'the readiness probe checks a dependency'),
              ],
            },
          ],
        },
        revision: {
          previousProposal: 'v1',
          feedback: 'f',
          requestedBy: 'reviewer',
          comments: [anchored('r-1', 'the image tag is mutable')],
        },
      }),
      registry(),
    )
    // An `anchorId` names an ITEM, not a finding, and one item collects several. Keyed on the
    // anchor alone both round-1 points hash together, so re-raising one folds BOTH out and the
    // count claims two are "listed in full above" when only one is: the probe ask would be dropped
    // from the prompt entirely and never raised with the producer again.
    expect(prompt).toContain('the readiness probe checks a dependency')
    expect(prompt.split('the image tag is mutable').length - 1).toBe(1)
    expect(prompt).toContain('1 point(s) raised in this round are still open')
  })

  it('renders a re-raise REWORDED under the same anchor twice, the safe direction of the error', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: {
          role: 'producer',
          threshold: 0.8,
          rounds: [
            {
              round: 1,
              rating: 0.6,
              passed: false,
              summary: 's',
              comments: [anchored('r-1', 'the image tag is mutable')],
            },
          ],
        },
        revision: {
          previousProposal: 'v1',
          feedback: 'f',
          requestedBy: 'reviewer',
          comments: [anchored('r-1', 'pin the image tag to a digest')],
        },
      }),
      registry(),
    )
    // Costs tokens; folding two different points together costs an ask.
    expect(prompt).toContain('the image tag is mutable')
    expect(prompt).toContain('pin the image tag to a digest')
  })

  it('keeps an UNANCHORED point that only matches by prose, and drops nothing else', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: {
          role: 'producer',
          threshold: 0.8,
          rounds: [
            {
              round: 1,
              rating: 0.6,
              passed: false,
              summary: 's',
              comments: [{ body: 'pathType is required' }, { body: 'name the ingress class' }],
            },
          ],
        },
        revision: {
          previousProposal: 'v1',
          feedback: 'f',
          requestedBy: 'reviewer',
          comments: [{ body: '  PathType is REQUIRED  ' }],
        },
      }),
      registry(),
    )
    // Whitespace and case are incidental differences between two renderings of one point.
    expect(prompt.toLowerCase().split('pathtype is required').length - 1).toBe(1)
    expect(prompt).toContain('name the ingress class')
  })

  it('does not point at a current-round list when this round listed no points', () => {
    // The heading names that list, and a producer looped back on prose feedback alone has none.
    // Claiming one is the same class of untruth the dedup exists to remove.
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        priorReview: { role: 'producer', threshold: 0.8, rounds: [rounds[0]!] },
        revision: { previousProposal: 'v1', feedback: 'tighten it up', requestedBy: 'reviewer' },
      }),
      registry(),
    )
    expect(prompt).not.toContain('The list above is the authoritative one')
    expect(prompt).toContain('Everything previously raised, so you do not undo a fix')
  })

  it('folds nothing out of a GRADER own verdicts, which have no current-round list beside them', () => {
    const prompt = userPromptFor(
      context({
        priorReview: {
          role: 'grader',
          threshold: 0.8,
          rounds: [
            {
              round: 1,
              rating: 0.6,
              passed: false,
              summary: 's',
              comments: [{ body: 'pathType is required' }],
            },
          ],
        },
      }),
      registry(),
    )
    expect(prompt).toContain('pathType is required')
    expect(prompt).not.toContain('still open and are listed in full above')
  })
})

describe('prompt assembly order', () => {
  it('puts the invariant injected context ahead of the volatile revision text', () => {
    // A provider prompt cache matches on a PREFIX. The context files are the same bytes on every
    // round of a rework loop and are the largest block here; the feedback is different bytes by
    // definition. Composed the other way round, each round paid a fresh cache WRITE for the whole
    // fold. Asserted as a RELATION rather than a rendered snapshot: what matters is which side of
    // the changing text the stable material lands on.
    const prompt = userPromptFor(
      context({
        agentKind: 'architect',
        injectedContextFiles: [{ path: 'brief.md', content: 'THE-STABLE-BRIEF' }],
        revision: {
          previousProposal: 'v1',
          feedback: 'THE-VOLATILE-FEEDBACK',
          requestedBy: 'reviewer',
        },
      }),
      registry(),
    )
    expect(prompt.indexOf('THE-STABLE-BRIEF')).toBeGreaterThan(-1)
    expect(prompt.indexOf('THE-STABLE-BRIEF')).toBeLessThan(prompt.indexOf('THE-VOLATILE-FEEDBACK'))
  })
})

describe('renderOpenFindings', () => {
  // What a CONSUMER of a reviewed artifact is told. The wording is the whole feature: the same
  // points rendered without "these were never answered" read as history a previous step already
  // dealt with, and a reader who believes that ignores them exactly as if they were never carried.

  const finding = (body: string, severity?: 'blocker' | 'major' | 'minor', anchorId?: string) => ({
    body,
    ...(severity ? { severity } : {}),
    ...(anchorId ? { anchorId } : {}),
  })

  it('names the producer and says plainly that the points are unfixed', () => {
    const text = renderOpenFindings('architect', [
      finding('rootDir src pulls the tests into the build', 'major', 'steps/2'),
    ]).join('\n')

    expect(text).toContain('`architect`')
    expect(text).toContain('They are not fixed.')
    expect(text).toContain('the run advanced regardless')
    expect(text).toContain('item `steps/2`')
    expect(text).toContain('[major]')
    expect(text).toContain('rootDir src pulls the tests into the build')
  })

  it('asks the reader not to build the defect in, never to go and revise the predecessor', () => {
    // A coder told to fix the design comes back with a design edit and no code.
    const text = renderOpenFindings('architect', [
      finding('the ingress class is wrong', 'major'),
    ]).join('\n')
    expect(text).toContain('do not build them in')
    expect(text).toMatch(/say so in your report/)
  })

  it('orders worst first and renders a point that anchors nothing against the output as a whole', () => {
    const text = renderOpenFindings('spec-writer', [
      finding('a general concern'),
      finding('must not ship', 'blocker'),
    ]).join('\n')

    expect(text.indexOf('must not ship')).toBeLessThan(text.indexOf('a general concern'))
    expect(text).toContain('On that output overall:')
  })

  it('states a trim rather than silently shortening a point', () => {
    const text = renderOpenFindings('architect', [finding('x'.repeat(5_000), 'major')]).join('\n')
    expect(text).toContain('… [trimmed]')
  })

  it('bounds the QUOTED locator too, keeping the heading one line that closes its quote', () => {
    // `quotedSource` is model- or human-authored prose of any length: spliced raw it carries a
    // body's worth of tokens into every downstream dispatch, and its own newlines end the heading
    // so the tail reads as the finding. The trim is stated, and the closing quote survives it.
    const lines = renderOpenFindings('architect', [
      { body: 'unhandled', severity: 'major', quotedSource: `y${'z'.repeat(5_000)}` },
    ])
    const heading = lines.find((l) => l.startsWith('On '))!

    expect(heading.split('\n')).toHaveLength(1)
    expect(heading.length).toBeLessThan(2_000)
    expect(heading).toContain('… [trimmed]"')
    expect(heading).toContain('[major]')
  })

  it('flattens a MULTI-LINE quoted locator instead of letting it end the heading', () => {
    const lines = renderOpenFindings('architect', [
      { body: 'name the owner', quotedSource: '## Rollout\n\nflip   the flag  ' },
    ])

    expect(lines).toContain('On "## Rollout flip the flag":')
  })

  it('renders nothing at all for an empty list', () => {
    // An empty section would read as "reviewed, defects: none", which is a claim nobody made.
    expect(renderOpenFindings('architect', [])).toEqual([])
  })
})

describe('open findings reach the next producer through the prompt', () => {
  // The end-to-end half: `userPromptFor` is the one assembly every dispatch goes through, so a
  // finding attached to a prior output has to come out of it attributed to that output. This is the
  // assertion that would have failed on the run that motivated the slice, where a `major` naming a
  // build-breaking tsconfig passed with the verdict and never reached the coder that implemented it.

  it('renders the section under the output it qualifies', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'coder',
        priorOutputs: [
          {
            agentKind: 'architect',
            output: 'Step 2: one tsconfig.json with rootDir src.',
            openFindings: [
              { body: 'rootDir src makes npm run build fail on the tests', severity: 'major' },
            ],
          },
        ],
      }),
      registry(),
    )

    expect(prompt).toContain('### architect')
    expect(prompt).toContain('Review findings still OPEN against the `architect` output')
    expect(prompt).toContain('rootDir src makes npm run build fail on the tests')
    // Under the artifact, not appended at the end of the prompt, so a run with two reviewed
    // producers cannot render a finding against the wrong one.
    expect(prompt.indexOf('### architect')).toBeLessThan(prompt.indexOf('still OPEN'))
  })

  it('reaches the BESPOKE prompt path too, not only the standard phase templates', () => {
    // Two assemblies render `priorOutputs`: the precompiled Handlebars partial every standard
    // phase shares, and `buildBaseUserPrompt` for a kind that is neither. A fold wired into one of
    // them is invisible for exactly the kinds a deployment adds itself, which is the half nobody
    // would notice was missing.
    const reg = registry()
    reg.register({ kind: 'auditor', systemPrompt: 'You audit.' })
    const prompt = userPromptFor(
      context({
        agentKind: 'auditor',
        priorOutputs: [
          {
            agentKind: 'architect',
            output: 'the design',
            openFindings: [{ body: 'the ingress is unclaimed', severity: 'major' }],
          },
        ],
      }),
      reg,
    )

    expect(prompt).toContain('Review findings still OPEN against the `architect` output')
    expect(prompt).toContain('the ingress is unclaimed')
  })

  it('leaves a prior output with nothing open completely unannotated', () => {
    const prompt = userPromptFor(
      context({
        agentKind: 'coder',
        priorOutputs: [{ agentKind: 'architect', output: 'a clean design' }],
      }),
      registry(),
    )
    expect(prompt).toContain('a clean design')
    expect(prompt).not.toContain('still OPEN')
  })
})
