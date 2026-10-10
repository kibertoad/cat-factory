import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  classifyLlmCallOutcome,
  debugCallOutcomeSchema,
  isLlmWarningFinishReason,
  llmCallOutcomeSchema,
  LLM_WARNING_FINISH_REASONS,
} from './index.js'

// The one classification every layer reaches for: the panel badge, both outcome filters, the
// debug list's `?outcome=` predicate and each store's SQL narrowing. It lived in three places
// (orchestration, the debug wire schema, a hand-written copy in the SPA) before it landed here,
// so these tests sit beside the implementation rather than beside any one of its callers.

describe('classifyLlmCallOutcome', () => {
  it('flags a failed call as an error', () => {
    expect(classifyLlmCallOutcome({ ok: false, finishReason: null })).toBe('error')
  })

  it('lets `ok: false` win over a warning-looking finish reason', () => {
    // A call that failed AND reported `length` is a failure, not a truncation. Counting it in
    // both buckets would make the panel's filter chips sum past the run's own call count.
    expect(classifyLlmCallOutcome({ ok: false, finishReason: 'length' })).toBe('error')
  })

  it('flags a truncated or filtered (but successful) call as a warning', () => {
    expect(classifyLlmCallOutcome({ ok: true, finishReason: 'length' })).toBe('warning')
    expect(classifyLlmCallOutcome({ ok: true, finishReason: 'content_filter' })).toBe('warning')
  })

  it('treats a normal completion as ok', () => {
    expect(classifyLlmCallOutcome({ ok: true, finishReason: 'stop' })).toBe('ok')
    expect(classifyLlmCallOutcome({ ok: true, finishReason: null })).toBe('ok')
  })
})

describe('isLlmWarningFinishReason', () => {
  it('matches exactly the declared warning reasons and nothing else', () => {
    // Derived from the list itself rather than restated: a reason ADDED to
    // `LLM_WARNING_FINISH_REASONS` must not need this test edited to stay true, and a member
    // silently dropped from it must fail here.
    for (const reason of LLM_WARNING_FINISH_REASONS) {
      expect(isLlmWarningFinishReason(reason)).toBe(true)
    }
    expect(isLlmWarningFinishReason('stop')).toBe(false)
    expect(isLlmWarningFinishReason(null)).toBe(false)
    expect(isLlmWarningFinishReason(undefined)).toBe(false)
  })
})

describe('the outcome vocabulary', () => {
  it('classifies into exactly the members the schema admits', () => {
    // The classifier and the picklist are the two halves of one closed vocabulary: a class the
    // classifier can return but the schema rejects is a 400 on a filter an operator was offered.
    const produced = new Set([
      classifyLlmCallOutcome({ ok: false, finishReason: null }),
      classifyLlmCallOutcome({ ok: true, finishReason: 'length' }),
      classifyLlmCallOutcome({ ok: true, finishReason: 'stop' }),
    ])
    expect([...produced].sort()).toEqual([...llmCallOutcomeSchema.options].sort())
    for (const outcome of produced) {
      expect(v.parse(llmCallOutcomeSchema, outcome)).toBe(outcome)
    }
  })

  it('is the SAME picklist the debug wire narrows by, not a copy of it', () => {
    // Identity, not deep equality: two picklists that merely agree today are the pair that
    // drifts the day a member is added to one of them.
    expect(debugCallOutcomeSchema).toBe(llmCallOutcomeSchema)
  })
})
