import { describe, expect, it } from 'vitest'
import { phasedProxyBaseUrl, type HarnessCallMetric } from '../src/pi.js'
import { unaccountedUsageCall } from '../src/usage-attribution.js'

// The live telemetry channel's one hard rule: a call handed to the stream is RECORDED, and the
// backend ignores the terminal repeat (first write wins, so a row's stored prompt delta stays
// valid against the tip it was written against). So nothing may be mutated after it is published —
// which is why the cumulative-usage reconciliation produces a NEW row rather than growing a turn.
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

describe('unaccountedUsageCall', () => {
  // The terminal `result` event's `usage.inputTokens` is every billed input bucket SUMMED, so the
  // already-accounted input is the sum of all three per-call classes.
  const costed = (
    input: number,
    cacheRead: number,
    output: number,
    text = 'turn',
  ): HarnessCallMetric => ({ ...call(text, input, output), cacheReadTokens: cacheRead })

  it('files the OUTPUT shortfall as its own row when every turn costed its input', () => {
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
    const remainder = unaccountedUsageCall(calls, { inputTokens: 117_153, outputTokens: 16_673 })

    // Every captured turn is left EXACTLY as the CLI reported it. A turn grown by thousands of
    // tokens it did not produce is a fabricated number that reads as a measured one.
    expect(calls.map((c) => [c.inputTokens, c.outputTokens])).toEqual([
      [2, 5],
      [2, 5],
      [2, 5],
      [2, 2],
    ])
    // Input already added up (8 fresh + 117,145 cache reads), so the row carries the output side
    // alone — and says it stands for the job rather than for a turn.
    expect(remainder).toEqual({
      promptText: '',
      messageCount: 0,
      responseText: '',
      reasoningText: '',
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 16_656,
      finishReason: null,
      standsForJob: true,
      // Four measured turns were filed beside it, so this row corrects THEIR under-reporting and
      // is not itself a call.
      spendOnly: true,
    })
    // The whole point: turns plus remainder reproduce the CLI's own total.
    expect(calls.reduce((n, c) => n + c.outputTokens, 0) + remainder!.outputTokens).toBe(16_673)
  })

  it('carries the WHOLE total when a CLI costed nothing at all', () => {
    // The case the previous rule was written for: a shortfall equal to the total.
    const remainder = unaccountedUsageCall([call('only')], { inputTokens: 300, outputTokens: 50 })
    // A NARRATED turn was filed, even though the CLI costed it at nothing, so this row is still a
    // correction rather than a second call: the turn is what the reader counts.
    expect(remainder).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      standsForJob: true,
      spendOnly: true,
    })
  })

  it('files NOTHING when the turns already account for the terminal total', () => {
    // A zero-token row here would be a claim about a call nobody made, and any row at all would
    // double-count in the step rollup.
    const calls = [costed(100, 900, 40, 'a'), costed(0, 1_000, 60, 'b')]
    expect(unaccountedUsageCall(calls, { inputTokens: 2_000, outputTokens: 100 })).toBeUndefined()
  })

  it('never subtracts when a CLI reports its two channels inconsistently', () => {
    // A terminal figure BELOW the per-turn sum is a contradiction in the CLI's own numbers, and
    // negative spend is not a thing to record. Clamped per side, so an over-reported input side
    // cannot cancel a genuine output shortfall.
    const remainder = unaccountedUsageCall([costed(500, 500, 5, 'a')], {
      inputTokens: 100,
      outputTokens: 900,
    })
    expect(remainder).toMatchObject({ inputTokens: 0, outputTokens: 895 })
  })

  it('counts only the PARENT loop, whose total the terminal event reports', () => {
    // In `ambientAuth` mode there is no transcript watcher, so the CLI's tagged subagent turns are
    // captured through the same publisher as the parent's. Subtracting one of them from the
    // parent-only cumulative would understate the shortfall — and pinning the remainder onto the
    // last captured call, as this once did, billed a subagent conversation for the parent's spend.
    const parent = [costed(2, 25_000, 5, 'parent')]
    const remainder = unaccountedUsageCall(parent, { inputTokens: 25_002, outputTokens: 9_001 })
    expect(remainder).toMatchObject({ inputTokens: 0, outputTokens: 8_996 })
  })

  it('files nothing when the CLI reported no terminal usage at all', () => {
    // Unknown is not zero: with no cumulative figure there is no shortfall to state.
    expect(unaccountedUsageCall([costed(10, 20, 30)], undefined)).toBeUndefined()
    expect(unaccountedUsageCall([], undefined)).toBeUndefined()
  })

  it('is the whole total, and a CALL, for a run that captured no turns', () => {
    // A CLI that narrated nothing but reported a cumulative: the row is the only record there is,
    // so it is NOT spend-only. Marking it so would report a step that burned tokens across zero
    // calls — the same reading `CliInlineLanguageModel` refuses with its own `reported > 0`.
    expect(unaccountedUsageCall([], { inputTokens: 1, outputTokens: 2 })).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
      standsForJob: true,
      spendOnly: false,
    })
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
