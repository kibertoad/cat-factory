import { describe, expect, it } from 'vitest'
import type {
  RequirementReviewItem,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import {
  buildReviewPrompt,
  coerceChunkRecommendations,
  coerceReviewItems,
  disposeReview,
  hasNotesToIncorporate,
  productIsIdentified,
  renderRequirements,
} from './requirements.logic.js'

function item(
  severity: ReviewItemSeverity,
  status: ReviewItemStatus = 'open',
): RequirementReviewItem {
  return {
    id: `i_${severity}_${status}`,
    category: 'gap',
    severity,
    title: 't',
    detail: 'd',
    status,
    reply: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('disposeReview', () => {
  const budget = { iteration: 1, maxIterations: 3 }

  it('auto-passes when there are no findings', () => {
    expect(disposeReview([], { ...budget, concernThreshold: 'none' })).toBe('auto-pass')
  })

  it('stops for a human when any finding exceeds the tolerated severity', () => {
    expect(disposeReview([item('high')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
    expect(disposeReview([item('low')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
  })

  it('auto-passes when every finding is at or below the tolerated severity', () => {
    expect(
      disposeReview([item('low'), item('medium')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('auto-pass')
    // A single high finding above the medium bar still stops.
    expect(
      disposeReview([item('low'), item('high')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('awaiting')
  })

  it('ignores dismissed/resolved findings when judging severity', () => {
    expect(
      disposeReview([item('high', 'dismissed'), item('low', 'open')], {
        ...budget,
        concernThreshold: 'none',
      }),
    ).toBe('awaiting')
    expect(
      disposeReview([item('high', 'dismissed')], { ...budget, concernThreshold: 'none' }),
    ).toBe('auto-pass')
  })

  it('reports exceeded once the iteration budget is spent and findings remain', () => {
    expect(
      disposeReview([item('high')], { iteration: 3, maxIterations: 3, concernThreshold: 'none' }),
    ).toBe('exceeded')
    // Tolerated findings auto-pass even at the cap.
    expect(
      disposeReview([item('low')], { iteration: 3, maxIterations: 3, concernThreshold: 'high' }),
    ).toBe('auto-pass')
  })

  it('rejects a non-positive cap or sub-1 iteration counter as a wiring bug', () => {
    expect(() =>
      disposeReview([item('high')], { iteration: 1, maxIterations: 0, concernThreshold: 'none' }),
    ).toThrow(/maxIterations/)
    expect(() =>
      disposeReview([item('high')], { iteration: 0, maxIterations: 3, concernThreshold: 'none' }),
    ).toThrow(/iteration/)
  })
})

describe('hasNotesToIncorporate', () => {
  const answered = (): RequirementReviewItem => ({
    ...item('medium', 'answered'),
    reply: 'use UTC timestamps',
  })

  it('is false when every finding was dismissed (nothing to fold in)', () => {
    expect(hasNotesToIncorporate([item('high', 'dismissed'), item('low', 'dismissed')])).toBe(false)
  })

  it('is false with no items and no feedback', () => {
    expect(hasNotesToIncorporate([])).toBe(false)
  })

  it('is true when a finding was answered with a non-empty reply', () => {
    expect(hasNotesToIncorporate([item('low', 'dismissed'), answered()])).toBe(true)
  })

  it('ignores an answered finding whose reply is blank', () => {
    expect(hasNotesToIncorporate([{ ...item('medium', 'answered'), reply: '   ' }])).toBe(false)
  })

  it('is true when the human gave freeform redo feedback even with no answers', () => {
    expect(hasNotesToIncorporate([item('low', 'dismissed')], 'restructure around tenants')).toBe(
      true,
    )
  })
})

describe('buildReviewPrompt', () => {
  it('instructs the reviewer to assign a severity to every finding', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('severity')
    expect(prompt).toContain('Assign a severity to EVERY item')
  })

  it('instructs the reviewer to classify each finding as autoAnswerable', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('autoAnswerable')
  })

  // The scope boundary is stated in the system prompt, but the user prompt is what lands LAST
  // in the model's context and carries the output contract, so it restates the boundary there —
  // including the escape hatch a model reaches for otherwise: keeping a technical question by
  // downgrading its severity.
  it('confines findings to the product / business layer and names who owns the rest', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('Every item must be a PRODUCT / BUSINESS question')
    expect(prompt).toContain('Do NOT raise technical design questions')
    expect(prompt).toContain('The Architect and Researcher steps own those')
    expect(prompt).toContain('do not downgrade its severity to squeeze it in')
  })

  it('accepts an empty result for purely technical work', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('the work is purely technical')
    expect(prompt).toContain('return an empty items array')
  })
})

describe('coerceReviewItems', () => {
  let n = 0
  const newId = () => `id-${n++}`

  it('carries the reviewer autoAnswerable classification, defaulting non-true to false', () => {
    n = 0
    const items = coerceReviewItems(
      {
        items: [
          { title: 'a', detail: 'da', severity: 'high', autoAnswerable: true },
          { title: 'b', detail: 'db', severity: 'high', autoAnswerable: false },
          { title: 'c', detail: 'dc', severity: 'high' }, // missing ⇒ false
          { title: 'd', detail: 'dd', severity: 'high', autoAnswerable: 'yes' }, // non-bool ⇒ false
        ],
      },
      newId,
      0,
    )
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.autoAnswerable]))
    expect(byTitle).toEqual({ a: true, b: false, c: false, d: false })
  })
})

describe('coerceChunkRecommendations', () => {
  const findings = (...ids: string[]): RequirementReviewItem[] =>
    ids.map((id) => ({
      id,
      category: 'gap',
      severity: 'high',
      title: `title-${id}`,
      detail: `detail-${id}`,
      status: 'recommend_requested',
      reply: null,
      createdAt: 0,
      updatedAt: 0,
    }))

  it('routes each suggestion to its finding by the echoed itemId', () => {
    const out = coerceChunkRecommendations(
      {
        recommendations: [
          { itemId: 'b', recommendation: 'for B' },
          { itemId: 'a', recommendation: 'for A', fromStandard: 'std-1' },
        ],
      },
      findings('a', 'b'),
    )
    expect(out.get('a')).toEqual({
      recommendation: 'for A',
      fromStandard: 'std-1',
      groundedIn: null,
      confidence: null,
    })
    expect(out.get('b')).toEqual({
      recommendation: 'for B',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
  })

  it('falls back to prompt order when the Writer omits the echoed itemIds', () => {
    // The whole batched response would otherwise be discarded (every finding force-reopened);
    // with no ids to route by, entries map to findings in the order the prompt listed them.
    const out = coerceChunkRecommendations(
      { recommendations: [{ recommendation: 'for A' }, { recommendation: 'for B' }] },
      findings('a', 'b'),
    )
    expect(out.get('a')).toEqual({
      recommendation: 'for A',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
    expect(out.get('b')).toEqual({
      recommendation: 'for B',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
  })

  it('mixes id-matched and positional fallback without stealing a matched entry', () => {
    // 'b' is echoed correctly; 'a' and 'c' come back id-less and fill the remaining findings in
    // order — the 'b' entry is consumed by its id match and not reused positionally.
    const out = coerceChunkRecommendations(
      {
        recommendations: [
          { recommendation: 'for A' },
          { itemId: 'b', recommendation: 'for B' },
          { recommendation: 'for C' },
        ],
      },
      findings('a', 'b', 'c'),
    )
    expect(out.get('a')).toEqual({
      recommendation: 'for A',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
    expect(out.get('b')).toEqual({
      recommendation: 'for B',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
    expect(out.get('c')).toEqual({
      recommendation: 'for C',
      fromStandard: null,
      groundedIn: null,
      confidence: null,
    })
  })

  it('drops entries with no recommendation text and leaves unfilled findings absent', () => {
    const out = coerceChunkRecommendations(
      { recommendations: [{ itemId: 'a', recommendation: '' }, { recommendation: '   ' }] },
      findings('a', 'b'),
    )
    expect(out.size).toBe(0)
  })
})

describe('renderRequirements — product identity', () => {
  const base = {
    block: { title: 'implement webhooks', type: 'service' as const, description: 'add webhooks' },
    docs: [],
    tasks: [],
  }

  it('names the owning service so a bare title is not the whole subject', () => {
    const rendered = renderRequirements({
      ...base,
      service: {
        stated: true,
        frameId: 'blk_1',
        title: 'billing-api',
        description: 'Invoicing and payment collection.',
      },
    })
    expect(rendered).toContain('## The system this work belongs to')
    expect(rendered).toContain('**billing-api**')
    expect(rendered).toContain('Invoicing and payment collection.')
  })

  it('folds the service spec intent in under a resolved service', () => {
    const rendered = renderRequirements({
      ...base,
      service: { stated: true, frameId: 'blk_1', title: 'billing-api' },
      specIntent: 'Bills customers monthly.',
    })
    expect(rendered).toContain('spec/overview.md')
    expect(rendered).toContain('Bills customers monthly.')
  })

  it('STATES that no system was resolved rather than omitting the section', () => {
    const rendered = renderRequirements({
      ...base,
      service: { stated: false, reason: 'not-under-a-service' },
    })
    expect(rendered).toContain('## The system this work belongs to')
    expect(rendered).toContain('NOT STATED')
    expect(rendered).toContain('do not infer a product')
  })

  it('says nothing when the reviewed block IS the service', () => {
    const rendered = renderRequirements({
      ...base,
      service: { stated: false, reason: 'block-is-the-service' },
    })
    expect(rendered).not.toContain('The system this work belongs to')
  })

  it('makes no claim either way when nothing resolved the field', () => {
    expect(renderRequirements(base)).not.toContain('The system this work belongs to')
  })
})

describe('renderRequirements — the original request survives a derived subject', () => {
  const base = {
    block: { title: 'T', type: 'service' as const, description: 'the words the requester wrote' },
    docs: [],
    tasks: [],
  }

  it('keeps the original description beside an incorporated document', () => {
    const rendered = renderRequirements({ ...base, incorporatedDoc: '# T — Requirements' })
    expect(rendered).toContain('## Current standardized requirements (under review)')
    expect(rendered).toContain('## Original request (as written by the requester)')
    expect(rendered).toContain('the words the requester wrote')
    expect(rendered).toContain('FLAG the divergence')
  })

  it('keeps the original description beside a brainstormed direction', () => {
    const rendered = renderRequirements({ ...base, refinedDirection: '# T — Direction' })
    expect(rendered).toContain('## Requirements direction (agreed in the brainstorm)')
    expect(rendered).toContain('the words the requester wrote')
  })

  it('prefers the incorporated document over the direction as the current subject', () => {
    const rendered = renderRequirements({
      ...base,
      incorporatedDoc: 'INCORPORATED',
      refinedDirection: 'DIRECTION',
    })
    expect(rendered).toContain('INCORPORATED')
    expect(rendered).not.toContain('DIRECTION')
  })
})

describe('productIsIdentified', () => {
  const base = {
    block: { title: 'T', type: 'service' as const, description: 'd' },
    docs: [],
    tasks: [],
  }

  it('is true for a resolved service and for a service-level review', () => {
    expect(
      productIsIdentified({ ...base, service: { stated: true, frameId: 'b', title: 'api' } }),
    ).toBe(true)
    expect(
      productIsIdentified({ ...base, service: { stated: false, reason: 'block-is-the-service' } }),
    ).toBe(true)
  })

  it('is false when no owning service was resolved, and when nothing was asked', () => {
    expect(
      productIsIdentified({ ...base, service: { stated: false, reason: 'not-under-a-service' } }),
    ).toBe(false)
    expect(productIsIdentified(base)).toBe(false)
  })
})

describe('buildReviewPrompt — unidentified system', () => {
  const base = {
    block: { title: 'implement webhooks', type: 'service' as const, description: '' },
    docs: [],
    tasks: [],
  }

  it('tells the reviewer to raise the unknown system as a finding instead of picking one', () => {
    const prompt = buildReviewPrompt({
      ...base,
      service: { stated: false, reason: 'not-under-a-service' },
    })
    expect(prompt).toContain('does not identify which system this work belongs to')
    expect(prompt).toContain('raise THAT as a finding')
  })

  it('adds nothing when the system IS identified', () => {
    const prompt = buildReviewPrompt({
      ...base,
      service: { stated: true, frameId: 'b', title: 'billing-api' },
    })
    expect(prompt).not.toContain('does not identify which system')
  })
})

describe('coerceChunkRecommendations — reported grounding', () => {
  const finding = item('high')

  it('keeps a recognised grounding level', () => {
    const out = coerceChunkRecommendations(
      { recommendations: [{ itemId: finding.id, recommendation: 'r', groundedIn: 'web' }] },
      [finding],
    )
    expect(out.get(finding.id)?.groundedIn).toBe('web')
  })

  it('reports null rather than guessing when the Writer omits or garbles the level', () => {
    const omitted = coerceChunkRecommendations(
      { recommendations: [{ itemId: finding.id, recommendation: 'r' }] },
      [finding],
    )
    expect(omitted.get(finding.id)?.groundedIn).toBeNull()
    const garbled = coerceChunkRecommendations(
      { recommendations: [{ itemId: finding.id, recommendation: 'r', groundedIn: 'vibes' }] },
      [finding],
    )
    expect(garbled.get(finding.id)?.groundedIn).toBeNull()
  })
})

describe('coerceChunkRecommendations — reported confidence', () => {
  const finding = item('high')
  const parse = (confidence: unknown) =>
    coerceChunkRecommendations(
      { recommendations: [{ itemId: finding.id, recommendation: 'r', confidence }] },
      [finding],
    ).get(finding.id)?.confidence

  it('keeps a grade inside the scale', () => {
    expect(parse(0.9)).toBe(0.9)
    expect(parse(0)).toBe(0)
    expect(parse(1)).toBe(1)
  })

  // An unwatched run compares this number against its policy floor, so every unusable value has to
  // land on the side that asks a person. A number OUTSIDE the scale is the sharp case: clamping
  // `5` to 1 would hand the run its strongest possible signal on the strength of a model that did
  // not understand the question.
  it('reads anything outside the scale as ungraded rather than clamping it', () => {
    expect(parse(5)).toBeNull()
    expect(parse(-1)).toBeNull()
    expect(parse(Number.NaN)).toBeNull()
    expect(parse('0.9')).toBeNull()
    expect(parse(undefined)).toBeNull()
  })
})
