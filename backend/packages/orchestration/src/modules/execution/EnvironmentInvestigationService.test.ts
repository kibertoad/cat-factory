import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type {
  Block,
  EnvironmentInvestigationSubject,
  ModelProvider,
  ModelRef,
} from '@cat-factory/kernel'
import {
  EnvironmentInvestigationService,
  type EnvironmentInvestigationServiceDeps,
} from './EnvironmentInvestigationService.js'

// Drives the real `generateText` over the AI SDK's test double, like `JudgeService.test.ts`.
//
// The failure worth covering is silent by construction: the investigation runs whatever prompt it
// is handed, so only a test that reads the system prompt back off the call can tell that a
// workspace's saved override actually reached it. Its prompt is a member of
// `INLINE_ENGINE_SYSTEM_PROMPTS`, which is what puts it in the prompt editor; an editor that shows
// a baseline no code path sends is exactly the bug that map exists to close.

const FALLBACK: ModelRef = { provider: 'qwen', model: 'qwen-coder' }
const BLOCK = { id: 'blk_1', title: 'Add catalog search' } as Block

function scripted(text: string, capture?: { system?: string }) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const first = options.prompt[0]
      if (capture && first?.role === 'system') capture.system = first.content
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
}

function subject(): EnvironmentInvestigationSubject {
  return {
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    block: BLOCK,
    evidence: {
      environment: {
        id: 'env_1',
        status: 'ready',
        url: null,
        expiresAt: null,
        lastError: null,
        provisionType: 'preview',
        engine: 'remote-custom',
      },
      provisionFields: {},
      timeline: [],
      failure: { error: 'never became ready', reason: 'timeout', readinessWait: 'not_reached' },
    },
    offeredActions: ['stop', 'reprovision'],
  }
}

function service(
  over: Partial<EnvironmentInvestigationServiceDeps> = {},
  text = '{"action":"stop"}',
) {
  const capture: { system?: string } = {}
  const deps: EnvironmentInvestigationServiceDeps = {
    modelProvider: { resolve: () => scripted(text, capture) } satisfies ModelProvider,
    modelRef: FALLBACK,
    ...over,
  }
  return { service: new EnvironmentInvestigationService(deps), capture }
}

describe('EnvironmentInvestigationService', () => {
  it('is disabled without a provider or without a routing default', () => {
    expect(new EnvironmentInvestigationService({ modelRef: FALLBACK }).enabled).toBe(false)
    expect(
      new EnvironmentInvestigationService({ modelProvider: { resolve: () => scripted('{}') } })
        .enabled,
    ).toBe(false)
    expect(service().service.enabled).toBe(true)
  })

  it('returns the RAW extracted JSON so an invented field cannot reach the domain', async () => {
    const { service: s } = service({}, '{"action":"reprovision","faultLayer":"nonsense"}')
    const answer = await s.investigate(subject())
    // Uncoerced on purpose: the caller owns the shape, exactly as `JudgeAssessor.assess` does.
    expect(answer.verdict).toEqual({ action: 'reprovision', faultLayer: 'nonsense' })
    expect(answer.model).toBe('qwen:qwen-coder')
  })

  it('sends the shipped prompt when the workspace has not edited it', async () => {
    const { service: s, capture } = service()
    await s.investigate(subject())
    expect(capture.system).toContain('You are a platform engineer investigating')
  })

  it("honours a workspace override of the role half and keeps the engine's directives", async () => {
    const { service: s, capture } = service({
      resolveSystemPromptOverride: async () => 'Diagnose it my way.',
    })
    await s.investigate(subject())
    expect(capture.system).toContain('Diagnose it my way.')
    expect(capture.system).not.toContain('You are a platform engineer investigating')
    // The JSON contract and the closed action vocabulary survive the override.
    expect(capture.system).toContain('"faultLayer"')
    expect(capture.system).toContain('only from the list the prompt says is offered')
  })

  it('resolves the override under its OWN kind, not a shared inline key', async () => {
    const asked: string[] = []
    const { service: s } = service({
      resolveSystemPromptOverride: async (_ws, kind) => {
        asked.push(kind)
        return undefined
      },
    })
    await s.investigate(subject())
    expect(asked).toEqual(['environment-investigator'])
  })

  it('throws rather than answering when the reply carries no JSON', async () => {
    // An unreadable reply is not a verdict of `stop`: the caller records the round as FAILED and
    // keeps the run's own error.
    const { service: s } = service({}, 'I could not determine the cause.')
    await expect(s.investigate(subject())).rejects.toThrow('returned no JSON verdict')
  })

  it('throws a named error when no model resolves', async () => {
    const s = new EnvironmentInvestigationService({
      modelProvider: { resolve: () => scripted('{}') },
      modelRef: undefined,
    })
    await expect(s.investigate(subject())).rejects.toThrow('No model is configured')
  })
})
