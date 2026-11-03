import { beforeEach, describe, expect, it, vi } from 'vitest'

// Partial over `importOriginal` for the reason `RequirementReviewService.autoRecommend.test.ts`
// gives: the agents barrel reaches for other `ai` exports at import time.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generateTextMock,
}))

import type { Block, RequirementReview, TaskEstimate } from '@cat-factory/kernel'
import { RequirementReviewService } from './RequirementReviewService.js'

const NOW = 1_000
let idCounter = 0

function blockWith(estimate: Partial<TaskEstimate> | null): Block {
  return {
    id: 'blk_1',
    title: 'Widgets endpoint',
    type: 'service',
    description: 'expose a widgets list endpoint',
    estimate: estimate ? { rationale: '', createdAt: NOW, ...estimate } : null,
  } as unknown as Block
}

function makeService(block: Block) {
  const store: { review: RequirementReview | null } = { review: null }
  const repository = {
    get: vi.fn(async () => store.review),
    getByBlock: vi.fn(async () => store.review),
    compareAndSwap: vi.fn(async (_ws: string, r: RequirementReview) => {
      r.rev = (r.rev ?? 0) + 1
      store.review = r
      return true
    }),
    replaceForBlock: vi.fn(async (_ws: string, r: RequirementReview) => {
      store.review = r
    }),
  }
  const svc = new RequirementReviewService({
    requirementReviewRepository: repository as never,
    blockRepository: { get: vi.fn(async () => block) } as never,
    idGenerator: { next: (p: string) => `${p}_${++idCounter}` } as never,
    clock: { now: () => NOW } as never,
    modelProvider: { resolve: vi.fn(() => ({}) as never) } as never,
    modelRef: { provider: 'cloudflare', model: 'test' },
  })
  return { svc, store }
}

/** The reviewer returns one finding per severity. */
function reviewerRaisesOneOfEach() {
  generateTextMock.mockResolvedValue({
    text: JSON.stringify({
      items: (['high', 'medium', 'low'] as const).map((severity) => ({
        category: 'gap',
        severity,
        title: `${severity} finding`,
        detail: `a ${severity} question`,
        autoAnswerable: false,
      })),
    }),
  })
}

const reviewerPrompt = (): string => {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as { prompt?: string; messages?: unknown }
  return JSON.stringify(call.prompt ?? call.messages)
}

const PROGRESSIVE = {
  requirementFindingFloor: 'medium' as const,
  requirementFloorProgression: { mediumFrom: 0.3, lowFrom: 0.7 },
}

describe('RequirementReviewService finding floor', () => {
  beforeEach(() => {
    idCounter = 0
    generateTextMock.mockReset()
    reviewerRaisesOneOfEach()
  })

  it('raises everything and records nothing when no floor is given', async () => {
    const { svc } = makeService(blockWith(null))
    const review = await svc.review('ws', 'blk_1')
    expect(review.items.map((i) => i.severity)).toEqual(['high', 'medium', 'low'])
    expect(review.findingFloor).toBeNull()
  })

  it('drops what falls below a fixed floor, counts it, and names the floor to the reviewer', async () => {
    const { svc } = makeService(blockWith(null))
    const review = await svc.review('ws', 'blk_1', {
      findingFloor: { requirementFindingFloor: 'medium', requirementFloorProgression: null },
    })
    expect(review.items.map((i) => i.severity)).toEqual(['high', 'medium'])
    expect(review.findingFloor).toEqual({
      severity: 'medium',
      basis: 'fixed',
      score: null,
      suppressed: 1,
    })
    expect(reviewerPrompt()).toContain('`high` and `medium` findings only')
  })

  it('moves a progressive floor with the block estimate', async () => {
    const small = makeService(blockWith({ complexity: 0.1, risk: 0.2, impact: 0.1 }))
    const asked = await small.svc.review('ws', 'blk_1', { findingFloor: PROGRESSIVE })
    expect(asked.items.map((i) => i.severity)).toEqual(['high'])
    expect(asked.findingFloor).toMatchObject({ severity: 'high', basis: 'estimate', score: 0.2 })

    const large = makeService(blockWith({ complexity: 0.4, risk: 0.9, impact: 0.5 }))
    const everything = await large.svc.review('ws', 'blk_1', { findingFloor: PROGRESSIVE })
    expect(everything.items).toHaveLength(3)
    expect(everything.findingFloor).toMatchObject({ severity: 'low', suppressed: 0 })
  })

  it('records the fallback when a progressive policy meets an unestimated task', async () => {
    const { svc } = makeService(blockWith(null))
    const review = await svc.review('ws', 'blk_1', { findingFloor: PROGRESSIVE })
    expect(review.findingFloor).toMatchObject({ severity: 'medium', basis: 'no_estimate' })
  })

  it('re-applies the floor on a re-review and records that pass', async () => {
    const { svc, store } = makeService(blockWith({ complexity: 0.5, risk: 0, impact: 0 }))
    await svc.review('ws', 'blk_1', { findingFloor: PROGRESSIVE })
    const reviewId = store.review!.id
    const next = await svc.reReview('ws', reviewId, {
      findingFloor: { requirementFindingFloor: 'high', requirementFloorProgression: null },
    })
    expect(next.iteration).toBe(2)
    expect(next.items.map((i) => i.severity)).toEqual(['high'])
    expect(next.findingFloor).toMatchObject({ severity: 'high', basis: 'fixed', suppressed: 2 })
  })
})
