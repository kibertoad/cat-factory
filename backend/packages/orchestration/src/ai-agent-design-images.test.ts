import type {
  AgentRunContext,
  BinaryArtifactStore,
  ModelProvider,
  ModelRef,
} from '@cat-factory/kernel'
import { AiAgentExecutor } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

// The WIRING test for design-picture delivery on the INLINE executor: what the model request
// actually carries, and what the prompt actually says about it. The pure halves are covered where
// they live (kernel's delivery join, the prompt section, the load/fold); this closes the gap
// between them and `run()`, which is where the two must agree.
//
// The case that drove it: the AMBIENT INLINE path serves a subscription ref by piping text to the
// developer's own CLI. It names a harness whose CONTAINER dispatch opens image files perfectly
// well, so reading that answer here once left the run claiming `channel: 'files'` while the bytes
// went nowhere, pointing the model at a directory that does not exist on a call with no checkout.

const PNG = new Uint8Array([137, 80, 78, 71])

/** A provider whose model records the options `generateText` hands its `doGenerate`. */
function recordingProvider(): { provider: ModelProvider; captured: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {}
  const provider: ModelProvider = {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          seen = options as unknown as Record<string, unknown>
          return {
            content: [{ type: 'text' as const, text: 'ok' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
  return { provider, captured: () => seen }
}

/** A store that always has the bytes, so a refusal can only come from the delivery decision. */
const store = {
  getBlob: async () => PNG,
} as unknown as BinaryArtifactStore

function executorFor(ref: ModelRef, opts: { runsInline?: boolean } = {}) {
  const { provider, captured } = recordingProvider()
  const exec = new AiAgentExecutor({
    modelProvider: provider,
    agentRouting: { default: { ref }, byKind: {} },
    resolveBlockModel: () => undefined,
    resolveBinaryArtifactStore: async () => store,
    ...(opts.runsInline ? { runsInline: () => true } : {}),
  })
  return { exec, captured }
}

function contextFor(): AgentRunContext {
  return {
    agentKind: 'architect' as AgentRunContext['agentKind'],
    pipelineName: 'design',
    stepIndex: 0,
    isFinalStep: true,
    workspaceId: 'ws_1',
    block: { title: 'Build the checkout screen', type: 'service', description: 'Do the thing' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    designImages: {
      files: [
        {
          view: 'Checkout',
          artifactId: 'art_1',
          contentType: 'image/png',
          fileName: 'Checkout.png',
        },
      ],
      omitted: [],
    },
  } as unknown as AgentRunContext
}

/**
 * The NON-TEXT parts of the one user message: the pictures, whatever content-part spelling the
 * SDK normalised them to on the way to the model. Asserted by exclusion rather than by naming the
 * part type, so an SDK that renames the shape does not silently turn this into a test of nothing.
 */
function imageParts(captured: Record<string, unknown>): Array<{ type?: string }> {
  const prompt = captured.prompt as Array<{ role?: string; content?: unknown }> | undefined
  const user = prompt?.find((m) => m.role === 'user')
  const parts = Array.isArray(user?.content) ? (user.content as Array<{ type?: string }>) : []
  return parts.filter((part) => part.type !== 'text')
}

function userText(captured: Record<string, unknown>): string {
  return JSON.stringify(captured.prompt ?? '')
}

describe('AiAgentExecutor design-picture delivery', () => {
  it('attaches the bytes as image parts and tells the model they are in the message', async () => {
    const { exec, captured } = executorFor({
      provider: 'anthropic',
      model: 'claude',
      acceptsImages: true,
    })
    await exec.run(contextFor())
    expect(imageParts(captured())).toHaveLength(1)
    expect(userText(captured())).toContain('attached to this message')
    expect(userText(captured())).not.toContain('.cat-context/design-renders')
  })

  it('refuses on the AMBIENT INLINE path instead of promising files nothing wrote', async () => {
    // `claude-code` opens an image file in a container, and this path has no checkout to put one
    // in and flattens its message to text on the way to the CLI. So the picture is withheld, the
    // agent is TOLD it was, and no directory is named.
    const { exec, captured } = executorFor(
      { provider: 'anthropic', model: 'claude', harness: 'claude-code', acceptsImages: true },
      { runsInline: true },
    )
    await exec.run(contextFor())
    expect(imageParts(captured())).toHaveLength(0)
    expect(userText(captured())).toContain('text-only channel')
    expect(userText(captured())).not.toContain('.cat-context/design-renders')
    // The views still have to reach it, or the textual description reads as everything there was.
    expect(userText(captured())).toContain('Checkout')
  })

  it('withholds the pictures when the model does not declare image input', async () => {
    const { exec, captured } = executorFor({ provider: 'anthropic', model: 'claude' })
    await exec.run(contextFor())
    expect(imageParts(captured())).toHaveLength(0)
    expect(userText(captured())).toContain('does not know whether')
  })
})
