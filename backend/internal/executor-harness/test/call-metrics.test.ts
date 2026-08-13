import { describe, expect, it } from 'vitest'
import { createCallMetricPublisher, phasedProxyBaseUrl, type HarnessCallMetric } from '../src/pi.js'
import { attributeCumulativeUsage } from '../src/usage-attribution.js'

// The live telemetry channel's one hard rule: a call handed to the stream is RECORDED, and the
// backend ignores the terminal repeat (first write wins, so a row's stored prompt delta stays
// valid against the tip it was written against). Anything still mutable therefore has to be held
// back — which is exactly what the cumulative-usage fallback does to a call's tokens.
//
// The end-to-end coverage of this lives in `agent-runner.test.ts` against a fake `claude` CLI,
// which only runs on POSIX; these assertions are the platform-independent half.

function call(responseText: string, inputTokens = 0, outputTokens = 0): HarnessCallMetric {
  return {
    promptText: '[]',
    messageCount: 1,
    responseText,
    reasoningText: '',
    inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    finishReason: null,
  }
}

describe('createCallMetricPublisher', () => {
  it('streams each call once its successor proves its tokens are final', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: HarnessCallMetric[] = []
    const publisher = createCallMetricPublisher(calls, (c) => streamed.push(c))

    publisher.publish(call('first', 100, 20))
    // Only the first is out: the second is the one attribution can still rewrite.
    expect(streamed.map((c) => c.responseText)).toEqual([])
    publisher.publish(call('second', 200, 30))
    expect(streamed.map((c) => c.responseText)).toEqual(['first'])
    publisher.flush()
    expect(streamed.map((c) => c.responseText)).toEqual(['first', 'second'])

    // Same instances: the job registry stamps `seq` on the object it is handed, and the terminal
    // list must carry that stamp so both channels mint one row id per call.
    expect(streamed[0]).toBe(calls[0])
    expect(streamed[1]).toBe(calls[1])
  })

  it('withholds the LAST call even when the CLI costed it, so attribution still lands', () => {
    // The regression this exists for. Claude Code costs every turn's INPUT while leaving its
    // output at the message-start snapshot, so the old "hold only un-costed calls" rule withheld
    // nothing, the last call streamed with ~5 output tokens, and the shortfall
    // `attributeCumulativeUsage` then pinned onto it lost the race to its own first write.
    const calls: HarnessCallMetric[] = []
    const streamed: Array<{ text: string; outputTokens: number }> = []
    const publisher = createCallMetricPublisher(calls, (c) =>
      // Snapshot AS PUBLISHED: the object is mutated by attribution afterwards, and what the
      // backend stores is the state at this moment.
      streamed.push({ text: c.responseText, outputTokens: c.outputTokens }),
    )

    const costed = call('costed', 25_394, 5)
    publisher.publish(costed)
    // Still on the terminal list, just not streamed — its output side is not final yet.
    expect(calls).toEqual([costed])
    expect(streamed).toEqual([])

    // What `attributeCumulativeUsage` does once the CLI's terminal `result` arrives.
    costed.outputTokens += 16_668
    publisher.flush()

    expect(streamed).toEqual([{ text: 'costed', outputTokens: 16_673 }])
  })

  it('flushes at most once, so a call is offered to the stream a single time', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: string[] = []
    const publisher = createCallMetricPublisher(calls, (c) => streamed.push(c.responseText))

    publisher.publish(call('uncosted'))
    publisher.flush()
    publisher.flush()

    expect(streamed).toEqual(['uncosted'])
  })

  it('releases every call in capture order across a whole run', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: string[] = []
    const publisher = createCallMetricPublisher(calls, (c) => streamed.push(c.responseText))

    for (const text of ['one', 'two', 'three']) publisher.publish(call(text, 10, 5))
    publisher.flush()

    expect(streamed).toEqual(['one', 'two', 'three'])
    // The abort path flushes too, and must not re-offer what it already released.
    publisher.flush()
    expect(streamed).toEqual(['one', 'two', 'three'])
  })

  it('appends to the run list with no stream wired (the proxy-metered path)', () => {
    const calls: HarnessCallMetric[] = []
    const publisher = createCallMetricPublisher(calls)

    publisher.publish(call('one', 10, 5))
    publisher.publish(call('two'))
    publisher.flush()

    expect(calls.map((c) => c.responseText)).toEqual(['one', 'two'])
  })
})

describe('attributeCumulativeUsage', () => {
  // The terminal `result` event's `usage.inputTokens` is every billed input bucket SUMMED, so the
  // already-accounted input is the sum of all three per-call classes.
  const costed = (
    input: number,
    cacheRead: number,
    output: number,
    text = 'turn',
  ): HarnessCallMetric => ({ ...call(text, input, output), cacheReadTokens: cacheRead })

  it('pins the OUTPUT shortfall onto the last call when every turn costed its input', () => {
    // The measured shape: Claude Code's `assistant` envelopes report the input and cache counts
    // final and `output_tokens` at the message-START snapshot (single digits), so a run whose
    // turns are all "costed" still has essentially its whole output side unaccounted. The old
    // all-or-nothing guard saw costed turns and returned, losing 16,668 of 16,673 output tokens.
    const calls = [
      costed(2, 40_963, 5, 'a'),
      costed(2, 25_394, 5, 'b'),
      costed(2, 25_394, 5, 'c'),
      costed(2, 25_394, 2, 'd'),
    ]
    attributeCumulativeUsage(calls, { inputTokens: 117_153, outputTokens: 16_673 })

    // Input already added up, so nothing was added to it: 8 fresh + 117,145 cache reads.
    expect(calls.map((c) => c.inputTokens)).toEqual([2, 2, 2, 2])
    // The last turn keeps its own 2 and grows by the 16,656 shortfall.
    expect(calls.map((c) => c.outputTokens)).toEqual([5, 5, 5, 16_658])
    expect(calls.reduce((n, c) => n + c.outputTokens, 0)).toBe(16_673)
  })

  it('still pins the WHOLE total when a CLI costed nothing at all', () => {
    // The case the previous rule was written for, unchanged: a shortfall equal to the total.
    const calls = [call('only')]
    attributeCumulativeUsage(calls, { inputTokens: 300, outputTokens: 50 })
    expect(calls[0]).toMatchObject({ inputTokens: 300, outputTokens: 50 })
  })

  it('adds nothing when the turns already account for the terminal total', () => {
    const calls = [costed(100, 900, 40, 'a'), costed(0, 1_000, 60, 'b')]
    attributeCumulativeUsage(calls, { inputTokens: 2_000, outputTokens: 100 })
    expect(calls.map((c) => [c.inputTokens, c.cacheReadTokens, c.outputTokens])).toEqual([
      [100, 900, 40],
      [0, 1_000, 60],
    ])
  })

  it('never subtracts when a CLI reports its two channels inconsistently', () => {
    // A terminal figure BELOW the per-turn sum is a contradiction in the CLI's own numbers, and
    // negative spend is not a thing to record. Clamped per side, so an over-reported input side
    // cannot cancel a genuine output shortfall.
    const calls = [costed(500, 500, 5, 'a')]
    attributeCumulativeUsage(calls, { inputTokens: 100, outputTokens: 900 })
    expect(calls[0]).toMatchObject({ inputTokens: 500, cacheReadTokens: 500, outputTokens: 900 })
  })

  it('is a no-op with no calls or no terminal usage', () => {
    const calls = [costed(10, 20, 30)]
    attributeCumulativeUsage(calls, undefined)
    expect(calls[0]).toMatchObject({ inputTokens: 10, cacheReadTokens: 20, outputTokens: 30 })
    expect(() => attributeCumulativeUsage([], { inputTokens: 1, outputTokens: 1 })).not.toThrow()
  })
})

describe('phasedProxyBaseUrl', () => {
  // The Pi path's phase carrier: Pi makes the proxy calls, from a config whose only per-run
  // knobs are the base URL and the token, so the phase rides a URL segment the backend reads
  // back off the request path (docs/initiatives/token-burn-instrumentation.md).
  it('tags the base URL with the phase the pass is running under', () => {
    expect(phasedProxyBaseUrl('https://api.test/v1', 'validation-repair', true)).toBe(
      'https://api.test/v1/phase/validation-repair',
    )
    // A trailing slash must not produce a double one — Pi appends `/chat/completions` verbatim.
    expect(phasedProxyBaseUrl('https://api.test/v1/', 'agent', true)).toBe(
      'https://api.test/v1/phase/agent',
    )
  })

  it('returns the plain base URL when there is no usable phase', () => {
    // No marker at all (an inline/one-shot caller), and a label the backend would discard
    // anyway: both take the canonical path, so the call is honestly unattributed rather than
    // sent to a URL that only looks attributed.
    expect(phasedProxyBaseUrl('https://api.test/v1', undefined, true)).toBe('https://api.test/v1')
    expect(phasedProxyBaseUrl('https://api.test/v1', '', true)).toBe('https://api.test/v1')
    expect(phasedProxyBaseUrl('https://api.test/v1', 'Not A Phase!', true)).toBe(
      'https://api.test/v1',
    )
    expect(phasedProxyBaseUrl('https://api.test/v1', 'x'.repeat(33), true)).toBe(
      'https://api.test/v1',
    )
  })

  it('never tags a backend that did not say it serves the phase route', () => {
    // The image and the backend are only a matched set on the Cloudflare deployment: a runner
    // pool pins its OWN harness image and `LOCAL_HARNESS_IMAGE` overrides the recommended pin,
    // so an image ahead of its backend would post EVERY model call to a 404 and kill the run.
    // The backend states what it serves (`proxyPhasePath` on the job body); absent ⇒ plain path
    // and honestly unattributed telemetry, which is a cost worth paying to never 404.
    expect(phasedProxyBaseUrl('https://api.test/v1', 'validation-repair', undefined)).toBe(
      'https://api.test/v1',
    )
    expect(phasedProxyBaseUrl('https://api.test/v1', 'agent', false)).toBe('https://api.test/v1')
  })
})
