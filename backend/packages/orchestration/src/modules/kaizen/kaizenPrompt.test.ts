import { describe, expect, it } from 'vitest'
import type { KaizenGrading, LlmCallMetric } from '@cat-factory/kernel'
import { buildKaizenPrompt } from './KaizenService.js'

// What the grader is TOLD about a step, which is the only evidence it has. Two of the six
// recommendations off a real grading were about defects that did not exist, both traceable to
// this text: an input figure that omitted the cache classes, and a null finish reason rendered as
// a value. A grader is a reader like any other, so the "degrade loudly" rules bind here.

const GRADING: KaizenGrading = {
  id: 'kzn_1',
  executionId: 'exec_1',
  blockId: 'blk_1',
  stepIndex: 0,
  agentKind: 'architect-companion',
  model: 'anthropic:claude-opus-5',
  promptVersion: 1,
  comboKey: 'k',
  status: 'running',
  grade: null,
  summary: '',
  recommendations: [],
  graderModel: null,
  error: null,
  createdAt: 0,
  updatedAt: 0,
}

function metric(over: Partial<LlmCallMetric> = {}): LlmCallMetric {
  return {
    id: 'llm_1',
    workspaceId: 'ws1',
    executionId: 'exec_1',
    agentKind: 'architect-companion',
    provider: 'anthropic',
    model: 'claude-opus-5',
    createdAt: 0,
    promptTokens: 2,
    cacheReadTokens: 25_394,
    cacheWriteTokens: 0,
    completionTokens: 5,
    totalTokens: 25_401,
    finishReason: null,
    ok: true,
    ...over,
  } as LlmCallMetric
}

describe('the Kaizen grader prompt', () => {
  it('reports the input side as all three classes, not fresh tokens alone', () => {
    // `promptTokens` is FRESH input by definition, so on a prompt-cached subscription run it is a
    // couple of tokens per call. Reported as "Prompt tokens (sum)" it read as 8 across 8 calls,
    // and the grader filed "fix prompt-token accounting: which is impossible" against telemetry
    // that had recorded the real 332,552 correctly, in the two columns beside it.
    const prompt = buildKaizenPrompt(GRADING, null, [
      metric(),
      metric({ promptTokens: 2, cacheReadTokens: 40_961, cacheWriteTokens: 76_182 }),
    ])

    expect(prompt).toContain(
      'Input tokens (sum): 142541 (4 fresh + 66355 cache reads + 76182 cache writes)',
    )
    expect(prompt).not.toContain('Prompt tokens')
  })

  it('says finish reasons were NOT REPORTED rather than reporting zero truncations', () => {
    const prompt = buildKaizenPrompt(GRADING, null, [metric(), metric()])

    expect(prompt).toContain('NOT REPORTED')
    // The trap: "Truncated calls (hit output limit): 0" is a measurement nobody took, and it
    // invites the grader to certify the step as cleanly completed.
    expect(prompt).not.toContain('Truncated calls')
    expect(prompt).not.toContain('unknown×2')
  })

  it('counts truncations, and names the shortfall, when the backend DOES report reasons', () => {
    const prompt = buildKaizenPrompt(GRADING, null, [
      metric({ finishReason: 'length' }),
      metric({ finishReason: 'stop' }),
      metric({ finishReason: null }),
    ])

    expect(prompt).toContain('Truncated calls (hit output limit): 1')
    expect(prompt).toContain('length×1, stop×1')
    expect(prompt).toContain('1 call(s) reported none')
  })

  it('names no CAUSE for a missing context snapshot', () => {
    // It used to guess "prompt recording may be off", which was wrong for every inline kind (there
    // was no capture site at all) and sent the grader after a switch already enabled.
    const prompt = buildKaizenPrompt(GRADING, null, [metric()])

    expect(prompt).toContain('No provided-context snapshot is available')
    expect(prompt).not.toContain('prompt recording may be off')
    expect(prompt).toContain('Do not infer why')
  })

  it('still says so when a step recorded no calls at all', () => {
    expect(buildKaizenPrompt(GRADING, null, [])).toContain(
      'No LLM calls were recorded for this step',
    )
  })
})
