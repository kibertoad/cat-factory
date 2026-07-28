import { describe, expect, it } from 'vitest'
import type {
  ExecutionInstance,
  LlmCallMetricPage,
  LlmCallMetricSummary,
  PipelineStep,
} from '@cat-factory/kernel'
import {
  deriveSignals,
  foldLlmRollup,
  sliceText,
  toDebugAgentContextDetail,
  toDebugLlmCall,
  toDebugRunStep,
  toDebugText,
} from './debug.logic.js'

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    decision: null,
    ...overrides,
  } as PipelineStep
}

function run(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Build',
    steps: [step()],
    currentStep: 0,
    status: 'done',
    createdAt: 1_000,
    ...overrides,
  } as ExecutionInstance
}

function summary(overrides: Partial<LlmCallMetricSummary> = {}): LlmCallMetricSummary {
  return {
    agentKind: 'coder',
    calls: 2,
    promptTokens: 100,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    completionTokens: 60,
    peakCompletionTokens: 50,
    maxOutputTokens: 100,
    truncatedCalls: 0,
    upstreamMs: 900,
    overheadMs: 100,
    errors: 0,
    warnings: 0,
    ...overrides,
  }
}

const EMPTY_SINKS = {
  llmCalls: { available: true, count: 1 },
  agentContext: { available: true, count: 1 },
  searchQueries: { available: true, count: 0 },
  provisioningLog: { available: true, count: 0 },
}

describe('sliceText', () => {
  it('reports what it returned AND what exists, so a cut body is never read as a short one', () => {
    expect(sliceText('hello world', 5)).toEqual({
      text: 'hello',
      chars: 5,
      totalChars: 11,
      truncated: true,
    })
  })

  it('returns no text but the real size at a zero budget (the sweep shape)', () => {
    expect(sliceText('hello', 0)).toEqual({ text: '', chars: 0, totalChars: 5, truncated: true })
  })

  it('marks a body that fits as untruncated, and never pads past the end', () => {
    expect(sliceText('hi', 100)).toEqual({ text: 'hi', chars: 2, totalChars: 2, truncated: false })
    expect(sliceText('', 10)).toEqual({ text: '', chars: 0, totalChars: 0, truncated: false })
  })

  it('counts and cuts in code points, never splitting a surrogate pair', () => {
    // Four emoji: 4 code points, 8 UTF-16 units. The budget is code points (the SQL unit).
    expect(sliceText('😀😀😀😀', 2)).toEqual({
      text: '😀😀',
      chars: 2,
      totalChars: 4,
      truncated: true,
    })
    expect(sliceText('😀😀', 10)).toEqual({
      text: '😀😀',
      chars: 2,
      totalChars: 2,
      truncated: false,
    })
  })
})

describe('toDebugText', () => {
  it("trusts the store's slice rather than re-slicing it", () => {
    // The repository already cut this in SQL; re-slicing here against a different budget would
    // make `chars` disagree with the text actually returned.
    expect(toDebugText({ text: 'abc', totalChars: 40 })).toEqual({
      text: 'abc',
      chars: 3,
      totalChars: 40,
      truncated: true,
    })
  })

  it('measures the returned slice in code points, matching the SQL total', () => {
    // A body of 10 emoji cut by SQL to 5: `.length` of the slice is 10 UTF-16 units, which
    // EQUALS the code-point total — a unit mix here read a halved body as untruncated.
    expect(toDebugText({ text: '😀😀😀😀😀', totalChars: 10 })).toEqual({
      text: '😀😀😀😀😀',
      chars: 5,
      totalChars: 10,
      truncated: true,
    })
  })
})

describe('toDebugRunStep', () => {
  it('projects the clocks and container mortality a stuck step is diagnosed from', () => {
    const projected = toDebugRunStep(
      step({
        agentKind: 'tester',
        state: 'working',
        progress: 0.5,
        model: 'openai:gpt',
        startedAt: 10,
        lastActivityAt: 99,
        output: 'abc',
        custom: { verdict: 'ok' },
        evictionRecoveries: 2,
        firstEvictionDetail: 'exit 137, OOM',
        subtasks: { completed: 1, inProgress: 1, total: 4 },
      }),
      3,
    )
    expect(projected).toMatchObject({
      index: 3,
      agentKind: 'tester',
      state: 'working',
      model: 'openai:gpt',
      startedAt: 10,
      finishedAt: null,
      lastActivityAt: 99,
      outputChars: 3,
      hasStructuredResult: true,
      evictionRecoveries: 2,
      subtasks: { completed: 1, inProgress: 1, total: 4 },
    })
    expect(projected.firstEvictionDetail?.text).toBe('exit 137, OOM')
  })

  it('defaults the absent optionals rather than emitting undefined', () => {
    const projected = toDebugRunStep(step(), 0)
    expect(projected.model).toBeNull()
    expect(projected.subtasks).toBeNull()
    expect(projected.firstEvictionDetail).toBeNull()
    expect(projected.evictionRecoveries).toBe(0)
    expect(projected.skipped).toBe(false)
    expect(projected.hasStructuredResult).toBe(false)
  })
})

describe('toDebugLlmCall', () => {
  const call: LlmCallMetricPage = {
    id: 'llm_1',
    workspaceId: 'ws',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt',
    createdAt: 5,
    streaming: true,
    messageCount: 12,
    toolCount: 3,
    requestMaxTokens: 1_000,
    promptTokens: 900,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    completionTokens: 1_000,
    totalTokens: 1_900,
    finishReason: 'length',
    upstreamMs: 100,
    overheadMs: 10,
    totalMs: 110,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptPrefixCount: 11,
    prompt: { text: '[{"role"', totalChars: 4_000 },
    response: { text: '', totalChars: 20 },
    reasoning: { text: '', totalChars: 0 },
  }

  it('classifies a truncated-but-successful call as a warning', () => {
    expect(toDebugLlmCall(call).outcome).toBe('warning')
    expect(toDebugLlmCall({ ...call, ok: false }).outcome).toBe('error')
    expect(toDebugLlmCall({ ...call, finishReason: 'stop' }).outcome).toBe('ok')
  })

  it('surfaces the elided prefix so a delta is never mistaken for the whole prompt', () => {
    const projected = toDebugLlmCall(call)
    expect(projected.elidedLeadingMessages).toBe(11)
    expect(projected.messageCount).toBe(12)
    expect(projected.prompt).toMatchObject({ totalChars: 4_000, truncated: true })
  })
})

describe('foldLlmRollup', () => {
  it('sums the per-kind aggregates and derives the ratios once', () => {
    const { totals, byAgentKind } = foldLlmRollup([
      summary(),
      summary({
        agentKind: 'tester',
        calls: 1,
        promptTokens: 100,
        cacheReadTokens: 0,
        errors: 1,
      }),
    ])
    expect(totals.calls).toBe(3)
    expect(totals.promptTokens).toBe(200)
    expect(totals.cacheReadTokens).toBe(40)
    // (read + write) / (fresh + read + write) = 40 / 240 — a share of the WHOLE input side,
    // not of the fresh count, so it can never exceed 1.
    expect(totals.cacheHitRate).toBeCloseTo(40 / 240)
    expect(totals.errors).toBe(1)
    expect(totals.transportOverheadRatio).toBeCloseTo(200 / 2_000)
    expect(byAgentKind.map((i) => i.agentKind)).toEqual(['coder', 'tester'])
    expect(byAgentKind[0]!.outputHeadroomRatio).toBeCloseTo(0.5)
  })

  it('yields zeroed totals with null ratios for a run that made no calls', () => {
    const { totals, byAgentKind } = foldLlmRollup([])
    expect(totals.calls).toBe(0)
    expect(totals.cacheHitRate).toBeNull()
    expect(totals.transportOverheadRatio).toBeNull()
    expect(byAgentKind).toEqual([])
  })
})

describe('deriveSignals', () => {
  const base = {
    steps: [],
    ...foldLlmRollup([]),
    sinks: EMPTY_SINKS,
    provisioningFailures: 0,
  }

  it('leads with the failure, then the provisioning cause, then the failed calls', () => {
    const signals = deriveSignals({
      ...base,
      execution: run({
        status: 'failed',
        failure: { kind: 'container_failed', message: 'boom' } as never,
      }),
      ...foldLlmRollup([summary({ errors: 2 })]),
      provisioningFailures: 1,
    })
    expect(signals.slice(0, 3).map((s) => s.code)).toEqual([
      'run_failed',
      'provisioning_failed',
      'llm_calls_failed',
    ])
    expect(signals[0]!.severity).toBe('error')
    expect(signals[2]!.count).toBe(2)
  })

  it('counts truncated calls per agent kind rather than leaving the arithmetic to the reader', () => {
    const rollup = foldLlmRollup([summary({ agentKind: 'coder', calls: 40, truncatedCalls: 13 })])
    const signals = deriveSignals({ ...base, execution: run(), ...rollup })
    const truncated = signals.find((s) => s.code === 'output_truncated')
    expect(truncated).toMatchObject({ severity: 'warning', count: 13, agentKind: 'coder' })
  })

  it('reports a container that kept dying, scoped to its step', () => {
    const steps = [toDebugRunStep(step({ evictionRecoveries: 3 }), 2)]
    const signals = deriveSignals({ ...base, execution: run(), steps })
    expect(signals.find((s) => s.code === 'container_evicted')).toMatchObject({
      count: 3,
      stepIndex: 2,
    })
  })

  it('distinguishes an unwired sink from a wired-but-empty one', () => {
    const unwired = deriveSignals({
      ...base,
      execution: run(),
      sinks: { ...EMPTY_SINKS, llmCalls: { available: false, count: 0 } },
    })
    // Unwired: the caller must not read the count as "nothing happened".
    expect(unwired.map((s) => s.code)).toContain('telemetry_unavailable')
    expect(unwired.map((s) => s.code)).not.toContain('no_model_calls')

    const wiredButEmpty = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      sinks: { ...EMPTY_SINKS, llmCalls: { available: true, count: 0 } },
    })
    // Wired and empty on a run that did not finish: no agent work is itself the finding.
    expect(wiredButEmpty.map((s) => s.code)).toContain('no_model_calls')

    const doneWithoutCalls = deriveSignals({
      ...base,
      execution: run({ status: 'done' }),
      sinks: { ...EMPTY_SINKS, llmCalls: { available: true, count: 0 } },
    })
    // A COMPLETED run with no calls is a legitimate shape (a gate-only pipeline), not a
    // "failed or stalled" diagnosis — the warning must not fire on success.
    expect(doneWithoutCalls.map((s) => s.code)).not.toContain('no_model_calls')
  })

  it('flags a cold prompt cache only once the run sent enough prompt to benefit', () => {
    const small = deriveSignals({
      ...base,
      execution: run(),
      ...foldLlmRollup([summary({ promptTokens: 1_000, cacheReadTokens: 0 })]),
    })
    expect(small.map((s) => s.code)).not.toContain('prompt_cache_cold')

    const large = deriveSignals({
      ...base,
      execution: run(),
      ...foldLlmRollup([summary({ promptTokens: 200_000, cacheReadTokens: 0 })]),
    })
    expect(large.map((s) => s.code)).toContain('prompt_cache_cold')
  })

  it('says a parked run is waiting on a human, not that it is broken', () => {
    const signals = deriveSignals({ ...base, execution: run({ status: 'blocked' }) })
    const parked = signals.find((s) => s.code === 'run_parked')
    expect(parked?.severity).toBe('info')
    expect(signals.some((s) => s.severity === 'error')).toBe(false)
  })
})

describe('toDebugAgentContextDetail', () => {
  it('budgets every body INDEPENDENTLY so one huge file cannot starve the prompts', () => {
    const detail = toDebugAgentContextDetail(
      {
        id: 'acs_1',
        workspaceId: 'ws',
        executionId: 'exec_1',
        agentKind: 'coder',
        stepIndex: 1,
        createdAt: 7,
        model: null,
        harness: 'pi',
        systemPrompt: 'SYSTEM-PROMPT',
        userPrompt: 'USER-PROMPT',
        fragments: [{ id: 'f1', body: 'x'.repeat(50) }],
        contextFiles: [
          { path: 'huge.md', title: 'Huge', url: 'u', content: 'y'.repeat(10_000) },
          { path: 'small.md', title: 'Small', url: 'u', content: 'zz' },
        ],
        extras: { branch: 'main' },
      },
      4,
    )
    // A shared allowance spent in array order would have returned the prompts empty.
    expect(detail.systemPrompt).toEqual({
      text: 'SYST',
      chars: 4,
      totalChars: 13,
      truncated: true,
    })
    expect(detail.userPrompt.text).toBe('USER')
    expect(detail.fragments[0]!.body.totalChars).toBe(50)
    // The file AFTER the 10 kB one still gets its own budget, and fits within it.
    expect(detail.contextFiles[1]!.content).toEqual({
      text: 'zz',
      chars: 2,
      totalChars: 2,
      truncated: false,
    })
    expect(detail.extras).toEqual({ branch: 'main' })
  })
})
