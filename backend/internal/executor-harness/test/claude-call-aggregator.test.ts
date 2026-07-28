import { describe, expect, it } from 'vitest'
import {
  createClaudeCallAggregator,
  isSubagentEvent,
  type AggregatedClaudeCall,
} from '../src/claude-call-aggregator.js'

/**
 * Claude Code splits ONE model response across several `assistant` envelopes (one per content
 * block), every one repeating that response's `usage`. These pin the fold-back: envelope count
 * must not be call count, or the burn instrumentation multiplies a run's input tokens by however
 * many blocks its turns happened to carry.
 */
function collect(): {
  calls: AggregatedClaudeCall[]
  agg: ReturnType<typeof createClaudeCallAggregator>
} {
  const calls: AggregatedClaudeCall[] = []
  return { calls, agg: createClaudeCallAggregator({ onCall: (call) => calls.push(call) }) }
}

/** One `assistant` envelope's `message` for a response split across blocks. */
function envelope(
  id: string,
  content: unknown[],
  usage: Record<string, number>,
  stopReason?: string,
): Record<string, unknown> {
  return {
    id,
    model: 'claude-opus-5',
    ...(stopReason ? { stop_reason: stopReason } : {}),
    usage,
    content,
  }
}

describe('createClaudeCallAggregator', () => {
  it('folds every envelope sharing a message id into ONE call, counting its tokens once', () => {
    const { calls, agg } = collect()
    const usage = { input_tokens: 40, cache_read_input_tokens: 49_621, output_tokens: 5 }
    // The shape that inflated the measured run: a text block plus five parallel tool calls,
    // arriving as six envelopes that each repeat the SAME usage.
    agg.onAssistant(envelope('msg_1', [{ type: 'text', text: 'Planning' }], usage))
    for (let i = 0; i < 5; i++) {
      agg.onAssistant(
        envelope('msg_1', [{ type: 'tool_use', name: 'TaskCreate', input: {} }], usage),
      )
      agg.onToolResult([{ type: 'tool_result', content: 'ok' }])
    }
    agg.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe(49_661)
    expect(calls[0]?.cachedInputTokens).toBe(49_621)
    expect(calls[0]?.toolUses).toBe(5)
    expect(calls[0]?.text).toBe('Planning')
    // The tool results are carried on the call, so the reconstruction can replay the real
    // request shape (one assistant turn holding all its blocks, then the results).
    expect(calls[0]?.toolResults).toHaveLength(5)
    expect(calls[0]?.content).toHaveLength(6)
  })

  it('takes the MAXIMUM of each usage bucket, so a growing output count is not truncated', () => {
    const { calls, agg } = collect()
    // Earlier envelopes of a response can carry the count as of the message start; the final
    // one carries the total. Which is which is a CLI detail — a max is right either way.
    agg.onAssistant(
      envelope('msg_1', [{ type: 'text', text: 'a' }], { input_tokens: 100, output_tokens: 7 }),
    )
    agg.onAssistant(
      envelope(
        'msg_1',
        [{ type: 'tool_use', name: 'Bash', input: {} }],
        { input_tokens: 100, output_tokens: 682 },
        'tool_use',
      ),
    )
    agg.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.outputTokens).toBe(682)
    expect(calls[0]?.inputTokens).toBe(100)
    expect(calls[0]?.stopReason).toBe('tool_use')
  })

  it('completes the call in flight when a new message id starts, before the new one begins', () => {
    const order: string[] = []
    const agg = createClaudeCallAggregator({
      onCallStart: () => order.push('start'),
      onCall: (call) => order.push(`call:${call.text}`),
    })
    agg.onAssistant(
      envelope('msg_1', [{ type: 'text', text: 'one' }], { input_tokens: 10, output_tokens: 1 }),
    )
    agg.onAssistant(
      envelope('msg_2', [{ type: 'text', text: 'two' }], { input_tokens: 20, output_tokens: 2 }),
    )
    agg.flush()

    // The prompt snapshot a caller takes in `onCallStart` must see the PREVIOUS call's turns
    // already appended, so the completion has to land first.
    expect(order).toEqual(['start', 'call:one', 'start', 'call:two'])
  })

  it('treats an envelope with no message id as its own call rather than merging blindly', () => {
    const { calls, agg } = collect()
    agg.onAssistant(
      envelope('', [{ type: 'text', text: 'a' }], { input_tokens: 10, output_tokens: 1 }),
    )
    agg.onAssistant(
      envelope('', [{ type: 'text', text: 'b' }], { input_tokens: 20, output_tokens: 2 }),
    )
    agg.flush()

    expect(calls.map((c) => c.text)).toEqual(['a', 'b'])
  })

  it('drops tool results that arrive before any call, and emits nothing on an empty stream', () => {
    const { calls, agg } = collect()
    agg.onToolResult([{ type: 'tool_result', content: 'orphan' }])
    agg.flush()
    expect(calls).toEqual([])
  })
})

describe('isSubagentEvent', () => {
  it('recognises the dispatch tag the CLI puts on a subagent turn', () => {
    expect(isSubagentEvent({ type: 'assistant', parent_tool_use_id: 'toolu_01' })).toBe(true)
  })

  it('treats an untagged turn as the parent loop’s', () => {
    expect(isSubagentEvent({ type: 'assistant' })).toBe(false)
    expect(isSubagentEvent({ type: 'assistant', parent_tool_use_id: null })).toBe(false)
    // An empty string is not a dispatch id; counting it as one would silently drop parent turns.
    expect(isSubagentEvent({ type: 'assistant', parent_tool_use_id: '' })).toBe(false)
  })
})
