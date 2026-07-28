import { describe, expect, it } from 'vitest'
import { createCallMetricPublisher, phasedProxyBaseUrl, type HarnessCallMetric } from '../src/pi.js'

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
