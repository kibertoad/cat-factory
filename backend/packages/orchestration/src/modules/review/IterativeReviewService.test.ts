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
