import { contextWindowFor } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { workersAiOutputCeiling } from '../src/modules/llmProxy/LlmProxyController.js'

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
