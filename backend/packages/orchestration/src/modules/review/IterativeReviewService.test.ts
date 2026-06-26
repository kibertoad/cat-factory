import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import { ClarityReviewService } from '../clarity/ClarityReviewService.js'

// The review services call `generateText` from the `ai` SDK directly; mock it so the test
// drives the real loop (review → reply → incorporate → re-review → converge) without an LLM.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))
vi.mock('ai', () => ({ generateText: generateTextMock }))

function llm(text: string, finishReason: 'stop' | 'length' = 'stop') {
  return { text, finishReason }
}

const ITEMS_ONE_HIGH = JSON.stringify({
  items: [
    { category: 'gap', severity: 'high', title: 'Missing edge case', detail: 'What if empty?' },
  ],
})

interface Stored {
  id: string
  blockId: string
}

function fakeRepo<T extends Stored>() {
  const byId = new Map<string, T>()
  return {
    byId,
    async get(_ws: string, id: string): Promise<T | null> {
      return byId.get(id) ?? null
    },
    async getByBlock(_ws: string, blockId: string): Promise<T | null> {
      return [...byId.values()].find((r) => r.blockId === blockId) ?? null
    },
    async upsert(_ws: string, review: T): Promise<void> {
      byId.set(review.id, review)
    },
    async deleteByBlock(_ws: string, blockId: string): Promise<void> {
      for (const [k, v] of byId) if (v.blockId === blockId) byId.delete(k)
    },
  }
}

const BLOCK = {
  id: 'blk_1',
  title: 'Add export',
  type: 'task',
  description: 'Let users export their data.',
  modelId: undefined,
  responsibleProductUserId: undefined,
} as unknown as Block

function baseDeps() {
  let n = 0
  return {
    blockRepository: { get: async () => BLOCK } as never,
    idGenerator: { next: (prefix = 'id') => `${prefix}_${++n}` },
    clock: { now: () => 1_000 },
    modelProvider: { resolve: () => ({}) as never },
    modelRef: { provider: 'fake', model: 'm' },
  }
}

const WS = 'ws_1'

beforeEach(() => {
  generateTextMock.mockReset()
})

describe('IterativeReviewService (via RequirementReviewService)', () => {
  function makeService() {
    const requirementReviewRepository = fakeRepo<{ id: string; blockId: string }>() as never
    const svc = new RequirementReviewService({ ...baseDeps(), requirementReviewRepository })
    return { svc }
  }

  it('runs the full loop: review → reply → incorporate → re-review → converge', async () => {
    const { svc } = makeService()

    generateTextMock.mockResolvedValueOnce(llm(ITEMS_ONE_HIGH))
    const review = await svc.review(WS, BLOCK.id, {})
    expect(review.status).toBe('ready') // a high finding above the 'none' threshold parks
    expect(review.items).toHaveLength(1)
    expect(review.incorporatedRequirements).toBeNull()
    expect(review.iteration).toBe(1)

    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'It returns an empty file.')

    generateTextMock.mockResolvedValueOnce(llm('# Standardized requirements\n...'))
    const { review: merged } = await svc.incorporate(WS, review.id, {})
    expect(merged.status).toBe('merged')
    expect(merged.incorporatedRequirements).toBe('# Standardized requirements\n...')

    generateTextMock.mockResolvedValueOnce(llm(JSON.stringify({ items: [] })))
    const reReviewed = await svc.reReview(WS, review.id, {})
    expect(reReviewed.status).toBe('incorporated') // no findings → auto-pass → advance
    expect(reReviewed.iteration).toBe(2)
    expect(reReviewed.incorporatedRequirements).toBe('# Standardized requirements\n...')
  })

  it('rejects a length-truncated rework rather than persisting a half-written document', async () => {
    const { svc } = makeService()
    generateTextMock.mockResolvedValueOnce(llm(ITEMS_ONE_HIGH))
    const review = await svc.review(WS, BLOCK.id, {})
    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'answer')

    generateTextMock.mockResolvedValueOnce(llm('truncated...', 'length'))
    await expect(svc.incorporate(WS, review.id, {})).rejects.toThrow(/cut off before completion/)
  })

  it('blocks incorporation while findings are still open', async () => {
    const { svc } = makeService()
    generateTextMock.mockResolvedValueOnce(llm(ITEMS_ONE_HIGH))
    const review = await svc.review(WS, BLOCK.id, {})
    await expect(svc.incorporate(WS, review.id, {})).rejects.toThrow(/before incorporating/)
  })
})

describe('RequirementReviewService recommendations (Requirement Writer, async)', () => {
  function makeService() {
    const requirementReviewRepository = fakeRepo<{ id: string; blockId: string }>() as never
    return new RequirementReviewService({ ...baseDeps(), requirementReviewRepository })
  }

  const TWO_FINDINGS = JSON.stringify({
    items: [
      { category: 'gap', severity: 'high', title: 'A', detail: 'a?' },
      { category: 'risk', severity: 'high', title: 'B', detail: 'b?' },
    ],
  })

  it('prepares pending placeholders, fills them async, and preserves a sibling answer', async () => {
    const svc = makeService()
    generateTextMock.mockResolvedValueOnce(llm(TWO_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const a = review.items[0]!
    const b = review.items[1]!

    // The human answers finding A explicitly, then asks the Writer to recommend for finding B.
    await svc.replyToItem(WS, review.id, a.id, 'My explicit answer to A.')
    const prepared = await svc.prepareRecommendations(WS, review.id, [b.id])
    // A `pending` placeholder appears at once (the async story); B is marked recommend_requested.
    expect(prepared.recommendations).toHaveLength(1)
    expect(prepared.recommendations[0]!.status).toBe('pending')
    expect(prepared.items.find((i) => i.id === b.id)!.status).toBe('recommend_requested')
    // A's explicit answer is untouched by requesting a recommendation for B.
    expect(prepared.items.find((i) => i.id === a.id)!.reply).toBe('My explicit answer to A.')

    // The Writer fills the placeholder in the background (one call per finding); progress streams.
    const progress: number[] = []
    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }] })),
    )
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {
      onProgress: async (r) =>
        progress.push(r.recommendations.filter((x) => x.status === 'ready').length),
    })
    expect(produced).toBe(1)
    expect(progress).toEqual([1])

    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations[0]!.status).toBe('ready')
    expect(after!.recommendations[0]!.recommendedText).toBe('Answer for B.')
    // The human's explicit answer to A is STILL there after the async recommendation cycle.
    expect(after!.items.find((i) => i.id === a.id)!.reply).toBe('My explicit answer to A.')
  })

  it('drops a failed placeholder and reopens its finding so the human can answer manually', async () => {
    const svc = makeService()
    generateTextMock.mockResolvedValueOnce(llm(TWO_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])

    generateTextMock.mockRejectedValueOnce(new Error('writer boom'))
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(0)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations).toHaveLength(0) // dead placeholder dropped
    expect(after!.items.find((i) => i.id === b.id)!.status).toBe('open') // reopened
  })

  it('accept folds the recommendation into the finding; reject reopens it', async () => {
    const svc = makeService()
    generateTextMock.mockResolvedValueOnce(llm(TWO_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])
    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }] })),
    )
    await svc.fillPendingRecommendations(WS, review.id, {})
    const recId = (await svc.getForBlock(WS, BLOCK.id))!.recommendations[0]!.id

    const accepted = await svc.acceptRecommendation(WS, review.id, recId)
    const item = accepted.items.find((i) => i.id === b.id)!
    expect(item.status).toBe('answered')
    expect(item.reply).toBe('Answer for B.')
  })

  it('reject reopens the source finding so it can be answered by hand', async () => {
    const svc = makeService()
    generateTextMock.mockResolvedValueOnce(llm(TWO_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])
    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }] })),
    )
    await svc.fillPendingRecommendations(WS, review.id, {})
    const recId = (await svc.getForBlock(WS, BLOCK.id))!.recommendations[0]!.id

    const rejected = await svc.rejectRecommendation(WS, review.id, recId)
    expect(rejected.recommendations[0]!.status).toBe('rejected')
    expect(rejected.items.find((i) => i.id === b.id)!.status).toBe('open')
  })

  it('keeps two findings with an identical title+detail distinct (one placeholder each)', async () => {
    const svc = makeService()
    // An LLM reviewer can raise two byte-identical findings; they must stay distinct so each
    // gets its own recommendation rather than collapsing into one (which would strand the other).
    const DUP_FINDINGS = JSON.stringify({
      items: [
        { category: 'gap', severity: 'high', title: 'Same', detail: 'same?' },
        { category: 'gap', severity: 'high', title: 'Same', detail: 'same?' },
      ],
    })
    generateTextMock.mockResolvedValueOnce(llm(DUP_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const [x, y] = review.items
    expect(review.items).toHaveLength(2)

    const prepared = await svc.prepareRecommendations(WS, review.id, [x!.id, y!.id])
    // Two placeholders despite identical title+detail — keyed on the finding id, not the text.
    expect(prepared.recommendations).toHaveLength(2)
    expect(prepared.recommendations.map((r) => r.sourceFinding.itemId).sort()).toEqual(
      [x!.id, y!.id].sort(),
    )

    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ itemId: x!.id, recommendation: 'For X.' }] })),
    )
    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ itemId: y!.id, recommendation: 'For Y.' }] })),
    )
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(2)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations.map((r) => r.recommendedText).sort()).toEqual([
      'For X.',
      'For Y.',
    ])
  })

  it('keeps a valid suggestion even when the Writer omits the echoed itemId', async () => {
    const svc = makeService()
    generateTextMock.mockResolvedValueOnce(llm(TWO_FINDINGS))
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])

    // Single-finding call: the model returns a recommendation but drops the echoed itemId
    // (common for one-item prompts). It must still be applied, not discarded as a failure.
    generateTextMock.mockResolvedValueOnce(
      llm(JSON.stringify({ recommendations: [{ recommendation: 'Answer for B.' }] })),
    )
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(1)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations[0]!.status).toBe('ready')
    expect(after!.recommendations[0]!.recommendedText).toBe('Answer for B.')
    // The finding is NOT reopened — the Writer succeeded.
    expect(after!.items.find((i) => i.id === b.id)!.status).toBe('recommend_requested')
  })
})

describe('IterativeReviewService (via ClarityReviewService)', () => {
  it('persists to its own document field (clarifiedReport) and threads the investigation', async () => {
    const clarityReviewRepository = fakeRepo<{ id: string; blockId: string }>() as never
    const svc = new ClarityReviewService({ ...baseDeps(), clarityReviewRepository })

    generateTextMock.mockResolvedValueOnce(llm(ITEMS_ONE_HIGH))
    const review = await svc.review(WS, BLOCK.id, {
      investigation: 'Stack trace points at parser.ts',
    })
    expect(review.status).toBe('ready')
    // The investigation flows through gatherContext into the reviewer prompt.
    expect(generateTextMock.mock.calls[0]![0].prompt).toContain('Stack trace points at parser.ts')

    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'answer')
    generateTextMock.mockResolvedValueOnce(llm('# Clarified bug report'))
    const { review: merged } = await svc.incorporate(WS, review.id, {})
    expect(merged.status).toBe('merged')
    expect(merged.clarifiedReport).toBe('# Clarified bug report')
    // The requirements field does not exist on a clarity review.
    expect((merged as Record<string, unknown>).incorporatedRequirements).toBeUndefined()
  })
})
