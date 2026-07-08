import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Requirement Writer LLM is reached through `generateText` from the `ai` package; mock it so
// the auto-recommendation path runs end-to-end without a provider. `vi.hoisted` lets the (hoisted)
// `vi.mock` factory reference the spy we assert on below.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))
vi.mock('ai', () => ({ generateText: generateTextMock }))

import type { Block, RequirementReview, RequirementReviewItem } from '@cat-factory/kernel'
import { RequirementReviewService } from './RequirementReviewService.js'

const NOW = 1_000
const BLOCK = {
  id: 'blk_1',
  title: 'Widgets endpoint',
  type: 'service',
  description: 'expose a widgets list endpoint',
} as unknown as Block

let idCounter = 0

function item(over: Partial<RequirementReviewItem> = {}): RequirementReviewItem {
  return {
    id: `rri_${++idCounter}`,
    category: 'gap',
    severity: 'high',
    title: `finding ${idCounter}`,
    detail: `detail ${idCounter}`,
    status: 'open',
    reply: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function reviewOf(items: RequirementReviewItem[]): RequirementReview {
  return {
    id: 'rrv_1',
    blockId: 'blk_1',
    status: 'ready',
    items,
    model: 'cloudflare:test',
    iteration: 1,
    maxIterations: 6,
    createdAt: NOW,
    updatedAt: NOW,
    incorporatedRequirements: null,
    recommendations: [],
  }
}

/** A service over an in-memory review store, with the Writer model wired (so it is `enabled`). */
function makeService(review: RequirementReview) {
  const store = { review }
  const repository = {
    get: vi.fn(async () => store.review),
    getByBlock: vi.fn(async () => store.review),
    upsert: vi.fn(async (_ws: string, r: RequirementReview) => {
      store.review = r
    }),
    deleteByBlock: vi.fn(async () => {}),
  }
  const notificationService = { raise: vi.fn(async () => {}) }
  const svc = new RequirementReviewService({
    requirementReviewRepository: repository as never,
    blockRepository: { get: vi.fn(async () => BLOCK) } as never,
    idGenerator: { next: (p: string) => `${p}_${++idCounter}` } as never,
    clock: { now: () => NOW } as never,
    modelProvider: { resolve: vi.fn(() => ({}) as never) } as never,
    modelRef: { provider: 'cloudflare', model: 'test' },
    notificationService: notificationService as never,
  })
  return { svc, repository, notificationService, store }
}

/** Make the mocked Writer return one recommendation (the single-finding coercion is id-tolerant). */
function writerReturns(text: string) {
  generateTextMock.mockResolvedValue({
    text: JSON.stringify({ recommendations: [{ recommendation: text, fromStandard: null }] }),
  })
}

describe('RequirementReviewService.autoRecommend', () => {
  beforeEach(() => {
    idCounter = 0
    generateTextMock.mockReset()
  })

  it('pre-answers only the OPEN, autoAnswerable findings and auto-accepts the recommendation', async () => {
    const auto = item({ title: 'pagination', detail: 'page size?', autoAnswerable: true })
    const business = item({ title: 'pricing tier', detail: 'which plans?', autoAnswerable: false })
    const alreadyAnswered = item({ autoAnswerable: true, status: 'answered', reply: 'set' })
    const { svc, store, notificationService } = makeService(
      reviewOf([auto, business, alreadyAnswered]),
    )
    writerReturns('Use cursor pagination, default page size 20.')

    const result = await svc.autoRecommend('ws', 'rrv_1')

    // The Writer ran for exactly the one qualifying finding.
    expect(generateTextMock).toHaveBeenCalledTimes(1)

    // The auto-answerable finding is now answered with the generated recommendation...
    const answered = result.items.find((i) => i.id === auto.id)!
    expect(answered.status).toBe('answered')
    expect(answered.reply).toBe('Use cursor pagination, default page size 20.')

    // ...its recommendation is auto (not human-requested) and already accepted...
    const rec = result.recommendations.find((r) => r.sourceFinding.itemId === auto.id)!
    expect(rec.auto).toBe(true)
    expect(rec.status).toBe('accepted')
    expect(rec.recommendedText).toBe('Use cursor pagination, default page size 20.')

    // ...the genuine business decision is left blank for the human...
    const untouched = result.items.find((i) => i.id === business.id)!
    expect(untouched.status).toBe('open')
    expect(untouched.reply).toBeNull()

    // ...the pre-answered finding must NOT raise the "recommendations to review" notification
    // (it is accepted the moment it is produced — there is no card for the human to act on).
    expect(notificationService.raise).not.toHaveBeenCalled()
    expect(store.review).toBe(result)
  })

  it('is a no-op (no Writer call, no write) when nothing qualifies', async () => {
    const { svc, repository } = makeService(
      reviewOf([
        item({ autoAnswerable: false }),
        item({ autoAnswerable: true, status: 'answered' }),
      ]),
    )

    await svc.autoRecommend('ws', 'rrv_1')

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(repository.upsert).not.toHaveBeenCalled()
  })

  it('a HUMAN-requested recommendation DOES notify (the auto suppression is auto-only)', async () => {
    const finding = item({ title: 'retry policy', detail: 'how many retries?' })
    const { svc, notificationService } = makeService(reviewOf([finding]))
    writerReturns('Retry idempotent calls up to 3 times with backoff.')

    // The non-auto path: prepare placeholders (no `auto`), then fill them.
    await svc.prepareRecommendations('ws', 'rrv_1', [finding.id])
    const result = await svc.fillPendingRecommendations('ws', 'rrv_1')

    expect(result.produced).toBe(1)
    // A human-requested recommendation lands in `ready` for a manual accept/reject and DOES
    // summon the human back via the notification.
    expect(notificationService.raise).toHaveBeenCalledTimes(1)
    expect(notificationService.raise).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ type: 'requirement_review' }),
    )
  })
})
