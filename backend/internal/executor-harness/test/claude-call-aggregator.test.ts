import { describe, expect, it } from 'vitest'
import {
  createClaudeCallAggregator,
  createClaudeRunTelemetry,
  isSubagentEvent,
  subagentDispatchId,
  type AggregatedClaudeCall,
} from '../src/claude-call-aggregator.js'
import type { HarnessCallMetric } from '../src/pi.js'

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
    // `inputTokens` is FRESH input only; the cache classes are carried apart, so a turn whose
    // prompt is 99.9% cache reads no longer hides behind one summed number.
    expect(calls[0]?.inputTokens).toBe(40)
    expect(calls[0]?.cacheReadTokens).toBe(49_621)
    expect(calls[0]?.cacheWriteTokens).toBe(0)
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
    expect(subagentDispatchId({ type: 'assistant', parent_tool_use_id: 'toolu_01' })).toBe(
      'toolu_01',
    )
  })

  it('treats an untagged turn as the parent loop’s', () => {
    expect(isSubagentEvent({ type: 'assistant' })).toBe(false)
    expect(isSubagentEvent({ type: 'assistant', parent_tool_use_id: null })).toBe(false)
    // An empty string is not a dispatch id; counting it as one would silently drop parent turns.
    expect(isSubagentEvent({ type: 'assistant', parent_tool_use_id: '' })).toBe(false)
    expect(subagentDispatchId({ type: 'assistant' })).toBeUndefined()
  })
})

describe('createClaudeRunTelemetry', () => {
  /** A run's telemetry plus the rows it published, with the subagent ownership under test. */
  function runTelemetry(watcherOwnsSubagents: boolean) {
    const published: HarnessCallMetric[] = []
    const telemetry = createClaudeRunTelemetry({
      seed: [{ role: 'system', content: 'SYS' }],
      secrets: [],
      watcherOwnsSubagents,
      publish: (metric) => published.push(metric),
    })
    return { published, telemetry }
  }

  it('keeps a subagent’s turns off the PARENT’s chain under either ownership', () => {
    // The splice is the defect that made `promptText` describe a request never sent, and it is
    // independent of which channel bills the subagent — so assert it on both settings.
    for (const watcherOwnsSubagents of [true, false]) {
      const { published, telemetry } = runTelemetry(watcherOwnsSubagents)
      telemetry.onAssistant(
        undefined,
        envelope('msg_1', [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }], {
          input_tokens: 100,
          output_tokens: 10,
        }),
      )
      telemetry.onAssistant(
        'toolu_a',
        envelope('msg_sub', [{ type: 'text', text: 'slice findings' }], {
          input_tokens: 19_430,
          output_tokens: 400,
        }),
      )
      telemetry.onToolResult('toolu_a', [{ type: 'tool_result', content: 'subagent tool output' }])
      telemetry.onToolResult(undefined, [{ type: 'tool_result', content: 'the Agent result' }])
      telemetry.onAssistant(
        undefined,
        envelope('msg_2', [{ type: 'text', text: 'aggregated' }], {
          input_tokens: 200,
          output_tokens: 20,
        }),
      )
      telemetry.flush()

      const parent = published.filter((c) => c.promptText.includes('SYS'))
      expect(parent.map((c) => c.inputTokens)).toEqual([100, 200])
      expect(parent[1]!.promptText).toContain('the Agent result')
      expect(parent[1]!.promptText).not.toContain('subagent tool output')
    }
  })

  it('bills the subagent itself when no watcher will run, and defers to the watcher when one will', () => {
    // Dropping the tagged turns with no watcher wired leaves them recorded by NEITHER channel —
    // an under-count, which reads as a cheap run rather than as an error.
    const withWatcher = runTelemetry(true)
    const withoutWatcher = runTelemetry(false)
    for (const { telemetry } of [withWatcher, withoutWatcher]) {
      telemetry.onAssistant(
        'toolu_a',
        envelope('msg_sub', [{ type: 'text', text: 'slice findings' }], {
          input_tokens: 19_430,
          output_tokens: 400,
        }),
      )
      telemetry.flush()
    }

    expect(withWatcher.published).toEqual([])
    expect(withoutWatcher.published.map((c) => c.inputTokens)).toEqual([19_430])
    // Seeded empty: the CLI minted that prompt and it never crossed this stream, so there is no
    // chain to delta against (`latestChainTip` skips a `messageCount: 0` row on purpose).
    expect(withoutWatcher.published[0]!.messageCount).toBe(0)

    // Only the deferring run can be let down by a silent watcher, so only it flags the shape.
    expect(withWatcher.telemetry.expectsWatcherCalls()).toBe(true)
    expect(withoutWatcher.telemetry.expectsWatcherCalls()).toBe(false)
  })

  it('expects nothing of the watcher on a run that dispatched no subagent', () => {
    const { telemetry } = runTelemetry(true)
    telemetry.onAssistant(
      undefined,
      envelope('msg_1', [{ type: 'text', text: 'solo' }], {
        input_tokens: 10,
        output_tokens: 1,
      }),
    )
    telemetry.flush()
    // Otherwise every ordinary run would warn about missing subagent rows it never had.
    expect(telemetry.expectsWatcherCalls()).toBe(false)
  })

  it('keeps concurrent subagents on separate transcripts', () => {
    // Two subagents run at once on ONE stdout; folding them into a single chain reproduces the
    // interleaved-promptText defect one level down.
    const { published, telemetry } = runTelemetry(false)
    telemetry.onAssistant(
      'toolu_a',
      envelope('msg_a1', [{ type: 'tool_use', name: 'Read', input: {} }], {
        input_tokens: 100,
        output_tokens: 10,
      }),
    )
    telemetry.onAssistant(
      'toolu_b',
      envelope('msg_b1', [{ type: 'tool_use', name: 'Grep', input: {} }], {
        input_tokens: 200,
        output_tokens: 20,
      }),
    )
    telemetry.onToolResult('toolu_a', [{ type: 'tool_result', content: 'A output' }])
    telemetry.onToolResult('toolu_b', [{ type: 'tool_result', content: 'B output' }])
    telemetry.onAssistant(
      'toolu_a',
      envelope('msg_a2', [{ type: 'text', text: 'A done' }], {
        input_tokens: 300,
        output_tokens: 30,
      }),
    )
    telemetry.flush()

    const second = published.find((c) => c.inputTokens === 300)!
    expect(second.promptText).toContain('A output')
    expect(second.promptText).not.toContain('B output')
  })

  it('drops a tool result for a dispatch whose turns never arrived', () => {
    const { published, telemetry } = runTelemetry(false)
    telemetry.onToolResult('toolu_unknown', [{ type: 'tool_result', content: 'orphan' }])
    telemetry.flush()
    // Minting a conversation from a result alone would publish a call that is all tool output
    // and no request.
    expect(published).toEqual([])
  })
})
