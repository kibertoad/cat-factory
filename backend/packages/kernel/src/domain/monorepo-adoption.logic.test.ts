import {
  adoptionAreaSchema,
  adoptionSourceSchema,
  MAX_ADOPTION_DROP_LINES,
  type AdoptionPlan,
  type AdoptionRead,
  type AdoptionSurvey,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.js'
import {
  describeAdoptionArea,
  describeAdoptionSource,
  isAdoptionArea,
  isAdoptionSource,
  MAX_ADOPTION_DECISIONS,
  monorepoBootstrapBranch,
  parseAdoptionDecisions,
  renderAdoptionBrief,
  renderAdoptionPrSection,
  resolveAdoptionReview,
} from './monorepo-adoption.logic.js'

/** One transcript entry, defaulting to a successful read (the case most assertions want). */
function read(path: string, overrides: Partial<AdoptionRead> = {}): AdoptionRead {
  return { path, origin: 'seed', outcome: 'read', chars: path.length, note: null, ...overrides }
}

const SURVEY: AdoptionSurvey = {
  reads: [
    read('monorepo:package.json'),
    read('monorepo:services/billing/package.json'),
    read('template:jest.config.js'),
  ],
  siblingServices: ['services/billing'],
  exploration: { calls: 2, maxCalls: 24, chars: 40, maxChars: 54_000, exhausted: null },
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-runner',
    area: 'testing',
    title: 'Test runner',
    monorepoPractice: 'vitest',
    templatePractice: 'jest',
    recommended: 'monorepo',
    rationale: 'One runner for the repo.',
    evidence: ['monorepo:package.json'],
    ...overrides,
  }
}

function readyPlan(decisions: unknown[]): AdoptionPlan {
  const { decisions: parsed } = parseAdoptionDecisions({ decisions }, SURVEY)
  return {
    status: 'ready',
    unavailableReason: null,
    unavailableDetail: null,
    survey: SURVEY,
    decisions: parsed,
    droppedUnevidenced: [],
    model: 'fake:advisor',
    generatedAt: 1,
  }
}

describe('parseAdoptionDecisions', () => {
  it('keeps a well-formed decision and carries its evidence through', () => {
    const { decisions, dropped } = parseAdoptionDecisions({ decisions: [decision()] }, SURVEY)
    expect(dropped).toEqual([])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      id: 'test-runner',
      area: 'testing',
      recommended: 'monorepo',
      evidence: ['monorepo:package.json'],
    })
  })

  it('drops a recommendation citing a file the survey never read, and says so', () => {
    // The one claim a reviewer cannot check by eye. Left in unmarked it reads as a convention
    // the platform verified, which is exactly what the evidence rule exists to prevent.
    const { decisions, dropped } = parseAdoptionDecisions(
      { decisions: [decision({ evidence: ['monorepo:invented/config.yaml'] })] },
      SURVEY,
    )
    expect(decisions).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain('cited no file the survey actually read')
  })

  it('drops evidence pointing at the wrong side even when the path itself was read', () => {
    // `package.json` exists on BOTH sides here, so an un-prefixed match would let a claim about
    // the monorepo be evidenced by the template's file of the same name.
    const { decisions } = parseAdoptionDecisions(
      { decisions: [decision({ evidence: ['template:package.json'] })] },
      SURVEY,
    )
    expect(decisions).toEqual([])
  })

  it('drops an unknown area or recommendation rather than storing an unrenderable one', () => {
    const { decisions, dropped } = parseAdoptionDecisions(
      {
        decisions: [
          decision({ id: 'a', area: 'vibes' }),
          decision({ id: 'b', recommended: 'whatever' }),
        ],
      },
      SURVEY,
    )
    expect(decisions).toEqual([])
    expect(dropped).toHaveLength(2)
  })

  it('keeps the first of two decisions sharing an id, so every choice stays addressable', () => {
    const { decisions, dropped } = parseAdoptionDecisions(
      { decisions: [decision({ title: 'First' }), decision({ title: 'Second' })] },
      SURVEY,
    )
    expect(decisions.map((d) => d.title)).toEqual(['First'])
    expect(dropped[0]).toContain('proposed twice')
  })

  it('caps the list and reports the cap rather than silently shortening it', () => {
    const many = Array.from({ length: MAX_ADOPTION_DECISIONS + 3 }, (_, i) =>
      decision({ id: `d-${i}` }),
    )
    const { decisions, dropped } = parseAdoptionDecisions({ decisions: many }, SURVEY)
    expect(decisions).toHaveLength(MAX_ADOPTION_DECISIONS)
    expect(dropped.join(' ')).toContain('the rest were not read')
  })

  it('reports a reply that is not a decision list at all', () => {
    expect(parseAdoptionDecisions({ nope: true }, SURVEY).dropped[0]).toContain(
      'no `decisions` array',
    )
    expect(parseAdoptionDecisions(null, SURVEY).decisions).toEqual([])
  })
})

describe('resolveAdoptionReview', () => {
  const plan = readyPlan([decision({ id: 'a' }), decision({ id: 'b' })])
  const context = { reviewedByUserId: 'usr_1', reviewedAt: 99 }

  it('records each settled choice and whether it overrode the suggestion', () => {
    const resolved = resolveAdoptionReview(
      plan,
      [
        { id: 'a', choice: 'monorepo' },
        { id: 'b', choice: 'template', note: '  keep ours  ' },
      ],
      { ...context, notes: '  be minimal  ' },
    )
    expect(resolved.decisions[0]).toMatchObject({
      id: 'a',
      choice: 'monorepo',
      overrodeRecommendation: false,
      note: null,
    })
    // The override flag is the difference between a default an agent may reason around and a
    // human decision it may not.
    expect(resolved.decisions[1]).toMatchObject({
      id: 'b',
      choice: 'template',
      overrodeRecommendation: true,
      note: 'keep ours',
    })
    expect(resolved.notes).toBe('be minimal')
    expect(resolved.reviewedByUserId).toBe('usr_1')
    expect(resolved.reviewedAt).toBe(99)
  })

  it('refuses an incomplete review instead of defaulting the gaps to the recommendation', () => {
    // Defaulting would erase the difference between agreeing with a suggestion and never having
    // read it, which is the single fact this whole step exists to record.
    let error: unknown
    try {
      resolveAdoptionReview(plan, [{ id: 'a', choice: 'monorepo' }], context)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details).toMatchObject({
      reason: 'adoption_review_incomplete',
      ids: ['b'],
    })
  })

  it('refuses an answer naming a decision the plan does not carry', () => {
    let error: unknown
    try {
      resolveAdoptionReview(
        plan,
        [
          { id: 'a', choice: 'monorepo' },
          { id: 'b', choice: 'monorepo' },
          { id: 'ghost', choice: 'monorepo' },
        ],
        context,
      )
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details).toMatchObject({ reason: 'adoption_choice_unknown' })
  })

  it('settles a plan that was never produced, so the human still gets the decision', () => {
    // An `unavailable` plan carries no decisions, so there is nothing to answer and nothing to
    // refuse. Refusing it anyway stranded the run: the review is the only exit from the park and
    // a retry re-enters the same phase, so a deployment with no adoption model could not
    // bootstrap into a monorepo at all. Their notes are what the agent then works from.
    const unavailable: AdoptionPlan = {
      ...plan,
      status: 'unavailable',
      unavailableReason: 'model_unavailable',
      decisions: [],
    }
    const settled = resolveAdoptionReview(unavailable, [], {
      ...context,
      notes: 'Follow the house.',
    })
    expect(settled.decisions).toEqual([])
    expect(settled.notes).toBe('Follow the house.')
    expect(settled.reviewedAt).toBe(context.reviewedAt)
  })

  it('still refuses an answer naming a decision an unavailable plan does not carry', () => {
    // The pair of checks that replaced the status guard: nothing to answer means nothing may BE
    // answered, so a review submitted against a plan that has since been re-surveyed is refused
    // whole rather than applied in part.
    const unavailable: AdoptionPlan = {
      ...plan,
      status: 'unavailable',
      unavailableReason: 'model_unavailable',
      decisions: [],
    }
    let error: unknown
    try {
      resolveAdoptionReview(unavailable, [{ id: 'a', choice: 'monorepo' }], context)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details).toMatchObject({ reason: 'adoption_choice_unknown' })
  })
})

describe('parseAdoptionDecisions drop reporting', () => {
  it('bounds the drop list and counts the overflow instead of listing it', () => {
    // A reply whose every entry is invalid never accumulates a kept decision, so the DECISION cap
    // never fires; without a second cap the wall it exists to prevent arrives through the drop
    // list, which is persisted whole on the plan and rendered to the reviewer.
    const survey: AdoptionSurvey = {
      reads: [read('monorepo:package.json')],
      siblingServices: [],
      exploration: { calls: 0, maxCalls: 24, chars: 0, maxChars: 54_000, exhausted: null },
    }
    const decisions = Array.from({ length: 300 }, (_, index) => ({
      id: `d${index}`,
      area: 'testing',
      title: `Invented ${index}`,
      recommended: 'monorepo',
      rationale: 'r',
      evidence: ['monorepo:does-not-exist.json'],
    }))
    const parsed = parseAdoptionDecisions({ decisions }, survey)
    expect(parsed.decisions).toEqual([])
    expect(parsed.dropped.length).toBe(MAX_ADOPTION_DROP_LINES + 1)
    expect(parsed.dropped.at(-1)).toContain('further proposals were dropped')
  })
})

describe('renderAdoptionPrSection', () => {
  it('neutralises the auto-link triggers in model- and reviewer-authored text', () => {
    // A pull request body is a PARSED surface: a closing keyword before an issue reference closes
    // that issue on merge, and `@name` mentions a stranger. Both holes here are untrusted (the
    // title is model-authored, the notes are the reviewer's), so both cross `hostMarkdown`.
    const section = renderAdoptionPrSection(
      {
        decisions: [
          {
            id: 'a',
            area: 'testing',
            title: 'Test runner',
            choice: 'monorepo',
            overrodeRecommendation: true,
            note: 'fixes #412, ask @acme/platform',
          },
        ],
        notes: 'closes #99',
        reviewedByUserId: 'u1',
        reviewedAt: 5,
      },
      'services/payments',
    )
    expect(section).not.toContain('#412')
    expect(section).not.toContain('@acme')
    expect(section).not.toContain('#99')
    // The information survives; only the triggers are inert.
    expect(section).toContain('412')
    expect(section).toContain('Test runner')
    expect(section).toContain('reviewer overrode the suggestion')
  })

  it('leaves the AGENT brief verbatim, because its reader is a model', () => {
    const brief = renderAdoptionBrief(
      {
        decisions: [],
        notes: 'fixes #412, ask @acme/platform',
        reviewedByUserId: 'u1',
        reviewedAt: 5,
      },
      'services/payments',
    )
    expect(brief).toContain('fixes #412, ask @acme/platform')
  })
})

describe('renderAdoptionBrief', () => {
  it('states every settled decision as a side, and marks the overrides', () => {
    const plan = readyPlan([decision({ id: 'a' })])
    const resolved = resolveAdoptionReview(
      plan,
      [{ id: 'a', choice: 'template', note: 'we need jest' }],
      { reviewedByUserId: null, reviewedAt: 1, notes: 'ship it' },
    )
    const brief = renderAdoptionBrief(resolved, 'services/payments')
    expect(brief).toContain('services/payments')
    expect(brief).toContain("keep the reference template's version as-is")
    expect(brief).toContain('reviewer overrode the suggestion')
    expect(brief).toContain('we need jest')
    expect(brief).toContain('ship it')
    // An agent that reads this as advice re-decides the areas the review exists to settle.
    expect(brief).toContain('decisions, not suggestions')
  })

  it('says so explicitly when a reviewer settled nothing, rather than rendering an empty list', () => {
    const brief = renderAdoptionBrief(
      { decisions: [], notes: null, reviewedByUserId: null, reviewedAt: 1 },
      'apps/web',
    )
    expect(brief).toContain('settled no areas')
  })
})

describe('the closed vocabularies', () => {
  it('renders every current area and source as its own distinct phrase', () => {
    const areas = adoptionAreaSchema.options.map(describeAdoptionArea)
    expect(new Set(areas).size).toBe(areas.length)
    for (const phrase of areas) expect(phrase).not.toContain('undefined')

    const sources = adoptionSourceSchema.options.map(describeAdoptionSource)
    expect(new Set(sources).size).toBe(sources.length)
    for (const phrase of sources) expect(phrase).not.toContain('undefined')
  })

  it('names a RETIRED stored value as retired instead of guessing a current one', () => {
    // Both `default` branches are unreachable while the type is honoured, so a value the union
    // does not have is the only thing that can demonstrate the runtime half works, and a stored
    // plan outliving a vocabulary change is exactly when it runs.
    expect(describeAdoptionArea('deployment' as never)).toContain('no longer defines')
    expect(describeAdoptionSource('either' as never)).toContain('no longer defines')
  })

  it('narrows a stored string against the schema its own options come from', () => {
    expect(isAdoptionArea('testing')).toBe(true)
    expect(isAdoptionArea('deployment')).toBe(false)
    expect(isAdoptionSource('both')).toBe(true)
    expect(isAdoptionSource('either')).toBe(false)
  })
})

describe('monorepoBootstrapBranch', () => {
  it('derives the branch from the RUN, so two similarly named services cannot collide', () => {
    expect(monorepoBootstrapBranch('boot_1')).not.toBe(monorepoBootstrapBranch('boot_2'))
    // Stable per run, so a retry resumes its branch instead of opening a second pull request.
    expect(monorepoBootstrapBranch('boot_1')).toBe(monorepoBootstrapBranch('boot_1'))
    expect(monorepoBootstrapBranch('boot_1')).toContain('boot_1')
  })
})
