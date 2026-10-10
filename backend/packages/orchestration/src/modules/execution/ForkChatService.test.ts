import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, ModelProvider } from '@cat-factory/kernel'
import type { ForkChatGrounding } from '@cat-factory/agents'
import { ForkChatService } from './ForkChatService.js'

// The chat responder runs a real `generateText` over the model the `ModelProvider` resolves;
// inject a deterministic `MockLanguageModelV3` (the AI SDK's own test double) so the suite drives
// the real SDK call path with scripted responses — mirroring DocInterviewService.test.ts.
type Scripted = { text: string } | { throw: Error }

function scriptedModel() {
  const queue: Scripted[] = []
  let lastPrompt = ''
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // Capture the rendered prompt so the test can assert the grounding reached the model.
      lastPrompt = JSON.stringify(options.prompt)
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
    get lastPrompt() {
      return lastPrompt
    },
  }
}

const BLOCK = {
  id: 'blk_1',
  title: 'Login task',
  type: 'task',
  level: 'task',
  description: 'Fix the login redirect.',
  modelId: undefined,
} as unknown as Block

const WS = 'ws_1'

const grounding: ForkChatGrounding = {
  description: 'Fix the login redirect.',
  seamSummary: 'the AuthController seam',
  forks: [
    {
      id: 'fork_0',
      title: 'Patch the call site',
      summary: 'targeted fix',
      approach: 'edit AuthController directly',
      tradeoffs: ['fast'],
      recommended: true,
    },
    {
      id: 'fork_1',
      title: 'Refactor the seam',
      summary: 'introduce an abstraction',
      approach: 'extract a SessionGateway',
      tradeoffs: ['cleaner'],
    },
  ],
  chat: [{ id: 'm1', role: 'human', text: 'Which is safer?', createdAt: 1 }],
}

function makeService(script: ReturnType<typeof scriptedModel>) {
  return new ForkChatService({
    modelProvider: { resolve: () => script.model } satisfies ModelProvider,
    modelRef: { provider: 'fake', model: 'm' },
  })
}

describe('ForkChatService', () => {
  it('is disabled without a model provider or ref', () => {
    expect(new ForkChatService({}).enabled).toBe(false)
    expect(
      new ForkChatService({
        modelProvider: { resolve: () => undefined as never },
      }).enabled,
    ).toBe(false)
  })

  it('answers a grounded turn, folding the forks + question into the prompt', async () => {
    const script = scriptedModel()
    script.push({ text: 'Patching the call site is safer here — it is localized.' })
    const svc = makeService(script)
    expect(svc.enabled).toBe(true)

    const { text, model } = await svc.respond(WS, BLOCK, grounding)
    expect(text).toBe('Patching the call site is safer here — it is localized.')
    expect(model).toBe('fake:m')
    // The rendered prompt carried the task, the seam, the fork titles, and the human question.
    expect(script.lastPrompt).toContain('Fix the login redirect.')
    expect(script.lastPrompt).toContain('the AuthController seam')
    expect(script.lastPrompt).toContain('Patch the call site')
    expect(script.lastPrompt).toContain('Which is safer?')
  })

  it('throws on an empty visible reply (reasoning-only output)', async () => {
    const script = scriptedModel()
    script.push({ text: '   ' })
    await expect(makeService(script).respond(WS, BLOCK, grounding)).rejects.toThrow(/empty reply/)
  })

  it('throws when the model call fails (so the driver can fall back to the canned reply)', async () => {
    const script = scriptedModel()
    script.push({ throw: new Error('provider exploded') })
    await expect(makeService(script).respond(WS, BLOCK, grounding)).rejects.toThrow(/failed/)
  })
})
