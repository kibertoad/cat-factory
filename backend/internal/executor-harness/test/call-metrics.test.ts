import { describe, expect, it } from 'vitest'
import { createCallMetricPublisher, type HarnessCallMetric } from '../src/pi.js'

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
    cachedInputTokens: 0,
    outputTokens,
    finishReason: null,
  }
}

describe('createCallMetricPublisher', () => {
  it('streams a costed call immediately, as the SAME object the terminal list holds', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: HarnessCallMetric[] = []
    const publisher = createCallMetricPublisher(calls, (c) => streamed.push(c))

    publisher.publish(call('first', 100, 20))
    publisher.publish(call('second', 200, 30))

    expect(streamed.map((c) => c.responseText)).toEqual(['first', 'second'])
    // Same instances: the job registry stamps `seq` on the object it is handed, and the terminal
    // list must carry that stamp so both channels mint one row id per call.
    expect(streamed[0]).toBe(calls[0])
    expect(streamed[1]).toBe(calls[1])
  })

  it('withholds an un-costed call from the stream until it is flushed', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: Array<{ text: string; inputTokens: number }> = []
    const publisher = createCallMetricPublisher(calls, (c) =>
      // Snapshot AS PUBLISHED: the object is mutated by attribution afterwards, and what the
      // backend stores is the state at this moment.
      streamed.push({ text: c.responseText, inputTokens: c.inputTokens }),
    )

    const uncosted = call('uncosted')
    publisher.publish(uncosted)
    // Still on the terminal list, just not streamed — the run's tokens aren't known yet.
    expect(calls).toEqual([uncosted])
    expect(streamed).toEqual([])

    // What `attributeCumulativeUsage` does once the CLI's terminal `result` arrives.
    uncosted.inputTokens = 300
    publisher.flush()

    expect(streamed).toEqual([{ text: 'uncosted', inputTokens: 300 }])
  })

  it('releases withheld calls as soon as a costed call proves attribution cannot fire', () => {
    const calls: HarnessCallMetric[] = []
    const streamed: string[] = []
    const publisher = createCallMetricPublisher(calls, (c) => streamed.push(c.responseText))

    publisher.publish(call('uncosted-1'))
    publisher.publish(call('uncosted-2'))
    expect(streamed).toEqual([])

    // The fallback only fires when NOTHING was costed, so this settles it for the whole run:
    // the withheld calls are final and go out in capture order, ahead of the call that freed them.
    publisher.publish(call('costed', 10, 5))
    expect(streamed).toEqual(['uncosted-1', 'uncosted-2', 'costed'])

    // And a later un-costed call no longer waits: a run that dies after this still reports it.
    publisher.publish(call('uncosted-3'))
    expect(streamed).toEqual(['uncosted-1', 'uncosted-2', 'costed', 'uncosted-3'])
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

  it('appends to the run list with no stream wired (the proxy-metered path)', () => {
    const calls: HarnessCallMetric[] = []
    const publisher = createCallMetricPublisher(calls)

    publisher.publish(call('one', 10, 5))
    publisher.publish(call('two'))
    publisher.flush()

    expect(calls.map((c) => c.responseText)).toEqual(['one', 'two'])
  })
})
