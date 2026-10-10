import { beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, DocInterviewSession, ModelProvider } from '@cat-factory/kernel'
import { DocInterviewService } from './DocInterviewService.js'

// The interviewer runs a real `generateText` over the model the `ModelProvider` resolves; inject a
// deterministic `MockLanguageModelV3` (the AI SDK's own test double) so the suite drives the real
// SDK call path with scripted responses — mirroring IterativeReviewService.test.ts.
type Scripted = { text: string } | { throw: Error }

function scriptedModel() {
  const queue: Scripted[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const next = queue.shift()
      if (!next) throw new Error('scriptedModel: no scripted response left')
      if ('throw' in next) throw next.throw
      return {
        content: [{ type: 'text', text: next.text }],
        finishReason: { unified: 'stop', raw: 'stop' },
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
    push(s: Scripted) {
      queue.push(s)
    },
  }
}

let script: ReturnType<typeof scriptedModel>

function fakeRepo() {
  const byId = new Map<string, DocInterviewSession>()
  return {
    byId,
    async get(_ws: string, id: string) {
      return byId.get(id) ?? null
    },
    async getByBlock(_ws: string, blockId: string) {
      return [...byId.values()].find((r) => r.blockId === blockId) ?? null
    },
    async upsert(_ws: string, session: DocInterviewSession) {
      byId.set(session.id, session)
    },
    async deleteByBlock(_ws: string, blockId: string) {
      for (const [k, v] of byId) if (v.blockId === blockId) byId.delete(k)
    },
  }
}

const BLOCK = {
  id: 'blk_1',
  title: 'Onboarding guide',
  type: 'task',
  description: 'Write an onboarding guide for the platform.',
  modelId: undefined,
} as unknown as Block

const WS = 'ws_1'

function makeService(repo = fakeRepo()) {
  let n = 0
  const service = new DocInterviewService({
    docInterviewRepository: repo as never,
    idGenerator: { next: (prefix = 'id') => `${prefix}_${++n}` },
    clock: { now: () => 1_000 },
    modelProvider: { resolve: () => script.model } satisfies ModelProvider,
    modelRef: { provider: 'fake', model: 'm' },
  })
  return { service, repo }
}

const emptySession = (): DocInterviewSession => ({
  id: '',
  blockId: BLOCK.id,
  status: 'awaiting',
  round: 0,
  maxRounds: 0,
  qa: [],
  brief: null,
  model: null,
  createdAt: 0,
  updatedAt: 0,
})

beforeEach(() => {
  script = scriptedModel()
})

describe('DocInterviewService.runInterview', () => {
  it('asks a batch of questions when the model returns them', async () => {
    const { service } = makeService()
    script.push({ text: JSON.stringify({ done: false, questions: ['Who is the audience?'] }) })
    const { output } = await service.runInterview(WS, BLOCK, emptySession(), { finalize: false })
    expect(output).toEqual({ kind: 'questions', questions: ['Who is the audience?'] })
  })

  it('throws on a non-final pass that yields neither questions nor a brief (empty/garbled output)', async () => {
    // A reasoning model that emits only into its thinking channel (empty visible reply) or prose
    // with no JSON: extractJson yields nothing, so a lenient coerce would silently converge with an
    // empty brief and skip the whole interview. The service must fail loudly instead.
    const { service } = makeService()
    script.push({ text: 'thinking... (no JSON here)' })
    await expect(
      service.runInterview(WS, BLOCK, emptySession(), { finalize: false }),
    ).rejects.toThrow(/no questions and no brief/)
  })

  it('does NOT throw on the FINAL round with an empty brief (graceful cap convergence)', async () => {
    // At the cap / on proceed the interview must settle even if the model returns a thin brief;
    // downstream falls back to the outline. Only the non-final empty case is an error.
    const { service } = makeService()
    script.push({ text: '{}' })
    const { output } = await service.runInterview(WS, BLOCK, emptySession(), { finalize: true })
    expect(output.kind).toBe('done')
  })

  it('converges with a synthesized brief when the model is done', async () => {
    const { service } = makeService()
    script.push({ text: JSON.stringify({ done: true, questions: [], brief: 'Write for admins.' }) })
    const { output } = await service.runInterview(WS, BLOCK, emptySession(), { finalize: false })
    expect(output).toEqual({ kind: 'done', brief: 'Write for admins.' })
  })
})

describe('DocInterviewService.clearForBlock', () => {
  it('drops the block’s session so a re-run starts clean', async () => {
    const { service, repo } = makeService()
    await repo.upsert(WS, { ...emptySession(), id: 'dis_1', status: 'done', brief: 'stale' })
    expect(await service.getByBlock(WS, BLOCK.id)).not.toBeNull()
    await service.clearForBlock(WS, BLOCK.id)
    expect(await service.getByBlock(WS, BLOCK.id)).toBeNull()
  })
})
