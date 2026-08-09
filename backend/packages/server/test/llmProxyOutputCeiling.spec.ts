import { contextWindowFor, redactImagePayloads } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  forwardedInputChars,
  workersAiOutputCeiling,
} from '../src/modules/llmProxy/LlmProxyController.js'

// The LLM proxy floors every workers-ai container call's `max_tokens` to 32K, then caps
// it against the model's context window so input + output fits. Regression guard for the
// blueprint run that 502'd because the 32K output floor alone filled qwen3-30b-a3b-fp8's
// 32K total window (Workers AI error 8007), leaving no room for the prompt.
describe('workersAiOutputCeiling', () => {
  const FLOOR = 32_768

  it('keeps the floor when the model has a large context window', () => {
    // kimi-k2.7-code: 256K window, a ~17K-char prompt leaves ample room.
    const window = contextWindowFor({
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.7-code',
    })
    expect(window).toBe(262_144)
    expect(workersAiOutputCeiling({ asked: 0, contextWindow: window, inputChars: 17_000 })).toBe(
      FLOOR,
    )
  })

  it('caps below the floor for a small-window model so the prompt still fits', () => {
    // The exact failing case: qwen3-30b-a3b-fp8 has a 32K TOTAL window. A ~16.8K-char
    // prompt must leave the output cap well under the window.
    const window = contextWindowFor({ provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' })
    expect(window).toBe(32_768)
    const inputChars = 16_779
    const ceiling = workersAiOutputCeiling({ asked: 0, contextWindow: window, inputChars })
    expect(ceiling).toBeLessThan(FLOOR)
    expect(ceiling).toBeGreaterThan(0)
    // input + output must fit the window (the estimate runs high, so this holds with margin).
    expect(Math.ceil(inputChars / 3) + ceiling).toBeLessThanOrEqual(window!)
  })

  it('leaves the floor untouched when the catalog declares no window', () => {
    expect(
      workersAiOutputCeiling({ asked: 0, contextWindow: undefined, inputChars: 1_000_000 }),
    ).toBe(FLOOR)
  })

  it('never widens an already-large asked value', () => {
    expect(workersAiOutputCeiling({ asked: 50_000, contextWindow: 262_144, inputChars: 100 })).toBe(
      50_000,
    )
  })

  it('does not cap to a non-positive value when the prompt alone overflows the window', () => {
    // A prompt larger than the window leaves no room; the call is doomed on input, but the
    // cap must not emit a zero/negative max_tokens — it leaves the floor in place.
    expect(workersAiOutputCeiling({ asked: 0, contextWindow: 32_768, inputChars: 200_000 })).toBe(
      FLOOR,
    )
  })
})

// What the ceiling MEASURES, which is a separate question from what the telemetry RECORDS. The two
// used to share one serialized string, and the moment image redaction landed on the recording half
// it silently shrank the measurement too.
describe('forwardedInputChars', () => {
  const image = `data:image/png;base64,${'A'.repeat(50_000)}`
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] },
    ] as unknown[],
  }

  it('measures the picture the request is actually sending', () => {
    expect(forwardedInputChars(payload)).toBeGreaterThan(50_000)
  })

  it('is not the redacted copy the telemetry stores', () => {
    // The regression, stated as the relation rather than as a pinned number: a described payload is
    // orders of magnitude smaller than the bytes going upstream, so measuring the record would
    // under-reserve window room by the whole size of every attached picture.
    const recorded = JSON.stringify(redactImagePayloads(payload.messages)).length
    expect(recorded).toBeLessThan(forwardedInputChars(payload))
  })

  it('counts the tool definitions beside the messages', () => {
    const withTools = { ...payload, tools: [{ name: 'edit_file', description: 'x'.repeat(1_000) }] }
    expect(forwardedInputChars(withTools)).toBeGreaterThan(forwardedInputChars(payload) + 1_000)
  })
})
