import { describe, expect, it } from 'vitest'
import { requirementsLogic } from '@cat-factory/orchestration'
import { classifyInlineCall, inlineReplyFor, type InlineCallKind } from './fakeInlineModel.ts'
import { FakeProfileRegistry } from './fakeProfile.ts'

// The inline-LLM fake answers each call by the SHAPE OF ITS PROMPT, because that is the only thing
// an inline call carries that says which step of the requirements loop it is. That makes the markers
// a copy of production strings, and a copy is a thing that rots.
//
// It rots SILENTLY and in the worst possible direction: an unmatched prompt falls through to the
// interview answer, whose JSON carries no `items`, so a drifted marker turns the requirements
// reviewer into one that raises nothing and auto-passes. `requirements-review.spec.ts` would then
// fail as "the run never parked", pointing at the engine rather than at this file.
//
// So these classify prompts built by the REAL builders (`requirementsLogic`, the same module the
// engine calls) rather than by hand-written strings, which would only ever pin the fake to itself.
// The contexts below are typed as the REAL `RequirementsContext` with no cast, so a new required
// field on it fails this lane instead of quietly rendering a prompt production never sends.

/**
 * The reviewer's context for a FIRST pass: no incorporated document yet.
 *
 * `type` is a real `Block['type']` member, which the typed context is how we know: the hand-written
 * `'feature'` this started as is not one, so the prompt it rendered was a shape production cannot
 * produce, and the cast that allowed it hid exactly that.
 */
function firstPassContext(): requirementsLogic.RequirementsContext {
  return {
    block: { title: 'Password reset', type: 'service', description: 'Let a user reset it.' },
    docs: [],
    tasks: [],
  }
}

/** The same context once an incorporation has produced a standardized document. */
function laterPassContext(): requirementsLogic.RequirementsContext {
  return {
    ...firstPassContext(),
    incorporatedDoc: '## Goal\n\nLet a user reset their own password.',
  }
}

/**
 * Classify a prompt the way the fake does: through the AI-SDK message shape it really sees. The
 * `text` key is the shape, not decoration. The fake searches the stringified prompt, so a part
 * spelled any other way would still match today and would stop matching the moment the fake
 * narrowed to reading text parts, leaving this guard passing against a shape nothing sends.
 */
function classifyAsSent(prompt: string): InlineCallKind {
  return classifyInlineCall(
    JSON.stringify([{ role: 'user', content: [{ type: 'text', text: prompt }] }]),
  )
}

describe('classifyInlineCall', () => {
  it('reads a first-pass reviewer prompt as the review', () => {
    expect(classifyAsSent(requirementsLogic.buildReviewPrompt(firstPassContext()))).toBe(
      'requirements-review',
    )
  })

  it('reads a reviewer prompt carrying the incorporated document as the RE-review', () => {
    // The distinction the whole loop turns on: the re-review renders the incorporated document
    // INSIDE the review prompt, so both markers are present and the more specific one must win.
    // Collapsing the two would make the fake raise its findings again forever, and the loop would
    // never converge.
    expect(classifyAsSent(requirementsLogic.buildReviewPrompt(laterPassContext()))).toBe(
      'requirements-re-review',
    )
  })

  it('reads the incorporation prompt as the incorporation, on the first pass and later ones', () => {
    for (const ctx of [firstPassContext(), laterPassContext()]) {
      expect(classifyAsSent(requirementsLogic.buildReworkPrompt(ctx, []))).toBe(
        'requirements-incorporate',
      )
    }
  })

  it('reads the Requirement Writer prompt as the recommendation, not as an interview', () => {
    // The fourth call this flow can make, and the one that used to land on the catch-all: it embeds
    // the same rendered requirements block as the review prompt but carries neither instruction
    // marker, so nothing distinguished it. Unnamed, it answered with interview JSON, which
    // `coerceRecommendations` reads as zero suggestions: a recommendation step that silently did
    // nothing. Driven with `laterPassContext` too, because that one embeds the incorporated-document
    // marker and so is the shape that could be mistaken for a re-review.
    for (const ctx of [firstPassContext(), laterPassContext()]) {
      const prompt = requirementsLogic.buildRecommendationPrompt(
        ctx,
        requirementsLogic.coerceReviewItems(
          { items: [{ title: 'Who may reset?', detail: 'Not stated.', autoAnswerable: true }] },
          () => 'item_1',
          0,
        ),
        { fragments: [], specExcerpts: [], webResults: [] },
      )
      expect(classifyAsSent(prompt)).toBe('requirements-recommend')
    }
  })

  it('falls through to the interview for anything it does not model', () => {
    expect(classifyAsSent('Ask the requester what they are trying to achieve.')).toBe('interview')
  })
})

describe('inlineReplyFor', () => {
  it('gives the reviewer the workspace’s scripted findings, in a shape the engine coerces', () => {
    const findings = [{ title: 'Who may reset?', detail: 'Not stated.', severity: 'high' as const }]
    const reply = inlineReplyFor('requirements-review', { reviewFindings: findings })
    // Parsed by the engine's own coercion, so a shape it would drop fails here rather than in a
    // browser as "the reviewer found nothing".
    const items = requirementsLogic.coerceReviewItems(JSON.parse(reply), () => 'item_1', 0)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Who may reset?', severity: 'high', status: 'open' })
  })

  it('raises nothing when no findings are scripted, so an unscripted workspace auto-passes', () => {
    for (const profile of [undefined, {}]) {
      const items = requirementsLogic.coerceReviewItems(
        JSON.parse(inlineReplyFor('requirements-review', profile)),
        () => 'item_1',
        0,
      )
      expect(items).toEqual([])
    }
  })

  it('always converges the re-review, whatever the first pass raised', () => {
    const reply = inlineReplyFor('requirements-re-review', {
      reviewFindings: [{ title: 'Who may reset?', detail: 'Not stated.' }],
    })
    expect(requirementsLogic.coerceReviewItems(JSON.parse(reply), () => 'i', 0)).toEqual([])
  })

  it('returns the incorporation as prose, never JSON', () => {
    expect(
      inlineReplyFor('requirements-incorporate', { incorporatedRequirements: '## Goal' }),
    ).toBe('## Goal')
    // A default is still a real document: an empty reply is REFUSED by the incorporation path.
    expect(inlineReplyFor('requirements-incorporate', {}).trim().length).toBeGreaterThan(0)
  })

  it('recommends nothing, in the shape the Writer path reads as "no suggestion"', () => {
    // Deliberately empty rather than invented: a synthesized recommendation is indistinguishable
    // from a real one in the window. What matters is that it parses as an empty RECOMMENDATION set
    // (leaving the finding open for the human) rather than as unparseable noise.
    const parsed = requirementsLogic.coerceRecommendations(
      JSON.parse(inlineReplyFor('requirements-recommend', {})),
    )
    expect(parsed.size).toBe(0)
  })
})

describe('E2eInlineModels', () => {
  it('is registered with the profile registry, so a mid-life profile write re-arms it', async () => {
    // Imported lazily: constructing it is the whole point of the assertion below.
    const { E2eInlineModels } = await import('./fakeInlineModel.ts')
    const registry = new FakeProfileRegistry()
    const models = new E2eInlineModels(registry)

    const findingsFor = async (workspaceId: string): Promise<unknown[]> => {
      const provider = await models.resolver.forScope({ workspaceId })
      const model = provider.resolve({ provider: 'mock', model: 'mock' })
      const result = await (
        model as unknown as {
          doGenerate(o: unknown): Promise<{ content: { type: string; text: string }[] }>
        }
      ).doGenerate({
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'text', text: requirementsLogic.buildReviewPrompt(firstPassContext()) },
            ],
          },
        ],
      })
      return JSON.parse(result.content[0]!.text).items as unknown[]
    }

    registry.set('ws_1', {})
    expect(await findingsFor('ws_1')).toEqual([])

    // The cached model read the profile once. Without the registry re-arming this cache the write
    // below is a silent no-op and the reviewer keeps finding nothing.
    registry.set('ws_1', { reviewFindings: [{ title: 'Who may reset?', detail: 'Not stated.' }] })
    expect(await findingsFor('ws_1')).toHaveLength(1)
  })
})
