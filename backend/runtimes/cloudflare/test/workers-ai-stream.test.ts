import { describe, expect, it } from 'vitest'
import { buildStreamChunks } from '../src/infrastructure/ai/WorkersAiLlmUpstream'

// Guards the Workers AI streaming serialization: a completed generation is replayed
// as OpenAI `chat.completion.chunk`s. The regression this exists for is token
// doubling — the streamed reply arriving with every token repeated. The fix replays
// the buffered text as ONE content chunk, so the key assertion is "content appears
// exactly once, verbatim", plus the chunk order Pi / any OpenAI client expects.

const meta = { id: 'chatcmpl-test', created: 1_700_000_000, model: '@cf/qwen/qwen3-test' }
const usage = { prompt_tokens: 11, completion_tokens: 7 }

function contentChunks(chunks: Array<Record<string, unknown>>): string[] {
  return chunks
    .map((c) => {
      const choice = (c.choices as Array<{ delta?: { content?: unknown } }> | undefined)?.[0]
      return choice?.delta?.content
    })
    .filter((v): v is string => typeof v === 'string')
}

describe('buildStreamChunks', () => {
  it('emits the text as a single content chunk, never per token', () => {
    const text = 'serviceservice observability summary'
    const chunks = buildStreamChunks(meta, { text, toolCalls: [], finishReason: 'stop', usage })

    const contents = contentChunks(chunks)
    expect(contents).toEqual([text])
    // The text is replayed verbatim in exactly one chunk — no splitting, no doubling.
    expect(contents.join('')).toBe(text)
  })

  it('orders chunks role → content → finish → usage', () => {
    const chunks = buildStreamChunks(meta, {
      text: 'hello',
      toolCalls: [],
      finishReason: 'stop',
      usage,
    })

    const first = chunks[0]!.choices as Array<{ delta?: { role?: string } }>
    expect(first[0]!.delta!.role).toBe('assistant')

    // Second is the lone content chunk.
    expect((chunks[1]!.choices as Array<{ delta?: { content?: string } }>)[0]!.delta!.content).toBe(
      'hello',
    )

    // Penultimate carries the finish reason; the last is usage-only (empty choices).
    const finishChunk = chunks.at(-2)!
    expect((finishChunk.choices as Array<{ finish_reason?: string }>)[0]!.finish_reason).toBe('stop')
    const usageChunk = chunks.at(-1)!
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })

    // Every chunk carries the shared envelope.
    for (const c of chunks) {
      expect(c).toMatchObject({ id: meta.id, object: 'chat.completion.chunk', model: meta.model })
    }
  })

  it('omits the content chunk when there is no text (tool-only reply)', () => {
    const toolCalls = [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'todo', arguments: '{}' } },
    ]
    const chunks = buildStreamChunks(meta, {
      text: '',
      toolCalls,
      finishReason: 'tool_calls',
      usage,
    })

    expect(contentChunks(chunks)).toEqual([])
    const toolChunk = chunks.find(
      (c) => (c.choices as Array<{ delta?: { tool_calls?: unknown } }>)[0]?.delta?.tool_calls,
    )
    expect(toolChunk).toBeDefined()
    expect((chunks.at(-2)!.choices as Array<{ finish_reason?: string }>)[0]!.finish_reason).toBe(
      'tool_calls',
    )
  })

  it('places the tool-call chunk after content and before finish', () => {
    const toolCalls = [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'todo', arguments: '{}' } },
    ]
    const chunks = buildStreamChunks(meta, {
      text: 'thinking',
      toolCalls,
      finishReason: 'tool_calls',
      usage,
    })

    const kinds = chunks.map((c) => {
      const choice = (c.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }>)[0]
      if (!choice) return 'usage'
      if (choice.delta?.role) return 'role'
      if (choice.delta?.content) return 'content'
      if (choice.delta?.tool_calls) return 'tools'
      return 'finish'
    })
    expect(kinds).toEqual(['role', 'content', 'tools', 'finish', 'usage'])
  })
})
