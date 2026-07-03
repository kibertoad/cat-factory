import { beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, ModelProvider, ModelRef } from '@cat-factory/kernel'
import { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import { ClarityReviewService } from '../clarity/ClarityReviewService.js'

// The review services run a real `generateText` over the model the `ModelProvider` resolves;
// inject a deterministic `MockLanguageModelV3` (the AI SDK's own test double) so the suite
// drives the real loop (review → reply → incorporate → re-review → converge) through the real
// SDK call path — no `vi.mock('ai')` coupling to the SDK's export shape. The model is scripted
// with one response per successive `generateText` call (the analogue of `mockResolvedValueOnce`),
// each either a `{ text, finishReason }` or an error to throw, and it captures every prompt.
type Scripted = { text: string; finishReason?: 'stop' | 'length' } | { throw: Error }

function scriptedModel() {
  const queue: Scripted[] = []
  const calls: string[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // The full prompt (system + user messages) the SDK hands the model, serialized so a
      // test can assert which context was fed in (the analogue of inspecting the mock's args).
      calls.push(JSON.stringify(options.prompt))
      const next = queue.shift()
      if (!next) throw new Error('scriptedModel: no scripted response left')
      if ('throw' in next) throw next.throw
      // AI SDK v6 expects the unified/raw finish-reason object from `doGenerate`; the public
      // `generateText` result surfaces it back as the plain `finishReason` string the service reads.
      const reason = next.finishReason ?? 'stop'
      return {
        content: [{ type: 'text', text: next.text }],
        finishReason: { unified: reason, raw: reason },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  return {
    model,
    calls,
    /** Queue the next `generateText` outcome (text, a length-truncation, or a throw). */
    push(s: Scripted) {
      queue.push(s)
    },
  }
}

let script: ReturnType<typeof scriptedModel>

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
    // Late-bound so each test's freshly-scripted model (set in beforeEach) is the one resolved.
    modelProvider: { resolve: () => script.model } satisfies ModelProvider,
    modelRef: { provider: 'fake', model: 'm' },
  }
}

const WS = 'ws_1'

beforeEach(() => {
  script = scriptedModel()
})

describe('IterativeReviewService (via RequirementReviewService)', () => {
  function makeService() {
    const requirementReviewRepository = fakeRepo<{ id: string; blockId: string }>() as never
    const svc = new RequirementReviewService({ ...baseDeps(), requirementReviewRepository })
    return { svc }
  }

  describe('inline model resolution (subscription harness)', () => {
    const CLAUDE_SUB: ModelRef = {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      harness: 'claude-code',
    }
    function serviceWith(extra: Record<string, unknown>) {
      const requirementReviewRepository = fakeRepo<{ id: string; blockId: string }>() as never
      return new RequirementReviewService({
        ...baseDeps(),
        requirementReviewRepository,
        resolveBlockModel: () => CLAUDE_SUB,
        ...extra,
      })
    }

    it('degrades a subscription harness model to the routing default (no inline harness)', async () => {
      const svc = serviceWith({})
      script.push({ text: JSON.stringify({ items: [] }) })
      const review = await svc.review(WS, BLOCK.id, {})
      // No inline-harness support ⇒ the reviewer runs the fallback provider model, not the sub.
      expect(review.model).toBe('fake:m')
    })

    it('keeps the subscription harness model when the deployment runs it inline (local ambient)', async () => {
      const svc = serviceWith({ runsInline: () => true })
      script.push({ text: JSON.stringify({ items: [] }) })
      const review = await svc.review(WS, BLOCK.id, {})
      expect(review.model).toBe('anthropic:claude-opus-4-8')
    })
  })

  it('runs the full loop: review → reply → incorporate → re-review → converge', async () => {
    const { svc } = makeService()

    script.push({ text: ITEMS_ONE_HIGH })
    const review = await svc.review(WS, BLOCK.id, {})
    expect(review.status).toBe('ready') // a high finding above the 'none' threshold parks
    expect(review.items).toHaveLength(1)
    expect(review.incorporatedRequirements).toBeNull()
    expect(review.iteration).toBe(1)

    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'It returns an empty file.')

    script.push({ text: '# Standardized requirements\n...' })
    const { review: merged } = await svc.incorporate(WS, review.id, {})
    expect(merged.status).toBe('merged')
    expect(merged.incorporatedRequirements).toBe('# Standardized requirements\n...')

    script.push({ text: JSON.stringify({ items: [] }) })
    const reReviewed = await svc.reReview(WS, review.id, {})
    expect(reReviewed.status).toBe('incorporated') // no findings → auto-pass → advance
    expect(reReviewed.iteration).toBe(2)
    expect(reReviewed.incorporatedRequirements).toBe('# Standardized requirements\n...')
  })

  it('rejects a length-truncated rework rather than persisting a half-written document', async () => {
    const { svc } = makeService()
    script.push({ text: ITEMS_ONE_HIGH })
    const review = await svc.review(WS, BLOCK.id, {})
    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'answer')

    script.push({ text: 'truncated...', finishReason: 'length' })
    await expect(svc.incorporate(WS, review.id, {})).rejects.toThrow(/cut off before completion/)
  })

  it('blocks incorporation while findings are still open', async () => {
    const { svc } = makeService()
    script.push({ text: ITEMS_ONE_HIGH })
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
    script.push({ text: TWO_FINDINGS })
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

    // The Writer fills the placeholder in the background (a batched call); progress streams.
    const progress: number[] = []
    script.push({
      text: JSON.stringify({
        recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }],
      }),
    })
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {
      onProgress: async (r) => {
        progress.push(r.recommendations.filter((x) => x.status === 'ready').length)
      },
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
    script.push({ text: TWO_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])

    script.push({ throw: new Error('writer boom') })
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(0)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations).toHaveLength(0) // dead placeholder dropped
    expect(after!.items.find((i) => i.id === b.id)!.status).toBe('open') // reopened
  })

  it('accept folds the recommendation into the finding; reject reopens it', async () => {
    const svc = makeService()
    script.push({ text: TWO_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])
    script.push({
      text: JSON.stringify({
        recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }],
      }),
    })
    await svc.fillPendingRecommendations(WS, review.id, {})
    const recId = (await svc.getForBlock(WS, BLOCK.id))!.recommendations[0]!.id

    const accepted = await svc.acceptRecommendation(WS, review.id, recId)
    const item = accepted.items.find((i) => i.id === b.id)!
    expect(item.status).toBe('answered')
    expect(item.reply).toBe('Answer for B.')
  })

  it('reject reopens the source finding so it can be answered by hand', async () => {
    const svc = makeService()
    script.push({ text: TWO_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])
    script.push({
      text: JSON.stringify({
        recommendations: [{ itemId: b.id, recommendation: 'Answer for B.' }],
      }),
    })
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
    script.push({ text: DUP_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    const [x, y] = review.items
    expect(review.items).toHaveLength(2)

    const prepared = await svc.prepareRecommendations(WS, review.id, [x!.id, y!.id])
    // Two placeholders despite identical title+detail — keyed on the finding id, not the text.
    expect(prepared.recommendations).toHaveLength(2)
    expect(prepared.recommendations.map((r) => r.sourceFinding.itemId).sort()).toEqual(
      [x!.id, y!.id].sort(),
    )

    // Both findings are answered by ONE batched Writer call (chunk size > 2); each suggestion is
    // still routed back to its own finding by itemId, so the two identical findings stay distinct.
    script.push({
      text: JSON.stringify({
        recommendations: [
          { itemId: x!.id, recommendation: 'For X.' },
          { itemId: y!.id, recommendation: 'For Y.' },
        ],
      }),
    })
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(2)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations.map((r) => r.recommendedText).sort()).toEqual([
      'For X.',
      'For Y.',
    ])
  })

  it('answers a batch of findings in chunks, not one Writer call per finding', async () => {
    const svc = makeService()
    // Five findings → with a chunk size of 4 the Writer is called ceil(5 / 4) = 2 times, not 5.
    const FIVE_FINDINGS = JSON.stringify({
      items: Array.from({ length: 5 }, (_, i) => ({
        category: 'gap',
        severity: 'high',
        title: `F${i}`,
        detail: `f${i}?`,
      })),
    })
    script.push({ text: FIVE_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    expect(review.items).toHaveLength(5)
    const ids = review.items.map((i) => i.id)
    await svc.prepareRecommendations(WS, review.id, ids)
    const callsBeforeFill = script.calls.length // just the one reviewer pass so far

    // First chunk answers findings 0-3 in one response; the second chunk answers finding 4.
    script.push({
      text: JSON.stringify({
        recommendations: ids.slice(0, 4).map((id, i) => ({ itemId: id, recommendation: `R${i}` })),
      }),
    })
    script.push({
      text: JSON.stringify({ recommendations: [{ itemId: ids[4]!, recommendation: 'R4' }] }),
    })
    const { produced } = await svc.fillPendingRecommendations(WS, review.id, {})
    expect(produced).toBe(5)
    // The whole point of batching: 2 Writer calls, not 5.
    expect(script.calls.length - callsBeforeFill).toBe(2)
    const after = await svc.getForBlock(WS, BLOCK.id)
    expect(after!.recommendations.every((r) => r.status === 'ready')).toBe(true)
    expect(after!.recommendations).toHaveLength(5)
  })

  it('keeps a valid suggestion even when the Writer omits the echoed itemId', async () => {
    const svc = makeService()
    script.push({ text: TWO_FINDINGS })
    const review = await svc.review(WS, BLOCK.id, {})
    const b = review.items[1]!
    await svc.prepareRecommendations(WS, review.id, [b.id])

    // Single-finding call: the model returns a recommendation but drops the echoed itemId
    // (common for one-item prompts). It must still be applied, not discarded as a failure.
    script.push({
      text: JSON.stringify({ recommendations: [{ recommendation: 'Answer for B.' }] }),
    })
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

    script.push({ text: ITEMS_ONE_HIGH })
    const review = await svc.review(WS, BLOCK.id, {
      investigation: 'Stack trace points at parser.ts',
    })
    expect(review.status).toBe('ready')
    // The investigation flows through gatherContext into the reviewer prompt.
    expect(script.calls[0]!).toContain('Stack trace points at parser.ts')

    await svc.replyToItem(WS, review.id, review.items[0]!.id, 'answer')
    script.push({ text: '# Clarified bug report' })
    const { review: merged } = await svc.incorporate(WS, review.id, {})
    expect(merged.status).toBe('merged')
    expect(merged.clarifiedReport).toBe('# Clarified bug report')
    // The requirements field does not exist on a clarity review.
    expect((merged as Record<string, unknown>).incorporatedRequirements).toBeUndefined()
  })
})
