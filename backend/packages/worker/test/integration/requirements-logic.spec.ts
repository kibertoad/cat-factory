import { requirementsLogic } from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'

// Pure logic for the requirements-review agent: rendering the collected
// requirements, building the review/incorporate prompts, and coercing the
// model's JSON into review items. Exercised in the Workers pool like the other
// prompt specs so the parsing runs in the real workerd runtime.

const {
  renderRequirements,
  buildReviewPrompt,
  buildIncorporatePrompt,
  coerceReviewItems,
  extractJson,
} = requirementsLogic

const ctx = {
  block: {
    title: 'Login',
    type: 'service' as const,
    description: 'Authenticate users',
  },
  docs: [{ title: 'Auth PRD', url: 'https://x/prd', excerpt: 'Users sign in with email.' }],
  tasks: [
    {
      key: 'PROJ-1',
      title: 'Rate limiter',
      status: 'Open',
      type: 'Story',
      description: '100 rps.',
    },
  ],
}

describe('requirements review logic', () => {
  it('renders the collected requirements with docs and issues', () => {
    const text = renderRequirements(ctx)
    expect(text).toContain('# Login (service)')
    expect(text).toContain('Authenticate users')
    expect(text).toContain('Auth PRD')
    expect(text).toContain('PROJ-1')
  })

  it('renders a placeholder when no description is provided', () => {
    const text = renderRequirements({
      block: { title: 'Empty', type: 'service', description: '' },
      docs: [],
      tasks: [],
    })
    expect(text).toContain('(no description provided)')
  })

  it('asks for a JSON item array in the review prompt', () => {
    const prompt = buildReviewPrompt(ctx)
    expect(prompt).toContain('"items"')
    expect(prompt).toContain('gap|clarification|assumption|risk|question')
  })

  it('extracts JSON tolerating code fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{ "items": [] }\n```'
    expect(extractJson(raw)).toEqual({ items: [] })
  })

  it('coerces model items, defaulting unknown category/severity and sorting by severity', () => {
    const now = 1000
    let n = 0
    const items = coerceReviewItems(
      {
        items: [
          { category: 'bogus', severity: 'low', title: 'A', detail: 'low one' },
          { category: 'gap', severity: 'high', title: 'B', detail: 'high one' },
          { category: 'risk', severity: 'medium', title: 'C', detail: 'mid one' },
        ],
      },
      () => `id-${n++}`,
      now,
    )
    expect(items.map((i) => i.title)).toEqual(['B', 'C', 'A'])
    // Unknown category falls back to 'question'; every item starts open + unanswered.
    expect(items.find((i) => i.title === 'A')!.category).toBe('question')
    expect(items.every((i) => i.status === 'open' && i.reply === null)).toBe(true)
    expect(items.every((i) => i.createdAt === now && i.updatedAt === now)).toBe(true)
  })

  it('drops items with no title and no detail, and caps the list at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      category: 'gap',
      severity: 'medium',
      title: `T${i}`,
      detail: `d${i}`,
    }))
    const items = coerceReviewItems({ items: [{ title: '', detail: '' }, ...many] }, () => 'x', 0)
    expect(items).toHaveLength(20)
  })

  it('returns an empty list for a non-object / empty response', () => {
    expect(coerceReviewItems(null, () => 'x', 0)).toEqual([])
    expect(coerceReviewItems({ items: [] }, () => 'x', 0)).toEqual([])
  })

  it('folds resolved answers into the incorporate prompt and excludes dismissed items', () => {
    const items = [
      {
        id: '1',
        category: 'gap' as const,
        severity: 'high' as const,
        title: 'Token expiry?',
        detail: 'How long do sessions last?',
        status: 'resolved' as const,
        reply: '24 hours',
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '2',
        category: 'risk' as const,
        severity: 'low' as const,
        title: 'Out of scope',
        detail: 'Some tangent',
        status: 'dismissed' as const,
        reply: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const prompt = buildIncorporatePrompt(ctx, items)
    expect(prompt).toContain('Token expiry?')
    expect(prompt).toContain('24 hours')
    expect(prompt).toContain('dismissed as out of scope')
    expect(prompt).toContain('Out of scope')
  })
})
