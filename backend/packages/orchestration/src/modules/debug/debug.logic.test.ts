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
  foldToolCallRollup,
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
    phase: 'agent',
    provider: 'anthropic',
    model: 'claude-opus-5',
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
    carryCostTokens: 300,
    costEstimate: null,
    ...overrides,
  }
}

const EMPTY_SINKS = {
  llmCalls: { available: true, count: 1 },
  agentContext: { available: true, count: 1 },
  searchQueries: { available: true, count: 0 },
  toolCalls: { available: true, count: 0, failed: 0 },
  provisioningLog: { available: true, count: 0 },
}

describe('sliceText', () => {
  it('reports what it returned AND what exists, so a cut body is never read as a short one', () => {
    expect(sliceText('hello world', 5)).toEqual({
      text: 'hello',
      chars: 5,
      offset: 0,
      totalChars: 11,
      truncated: true,
    })
  })

  it('returns no text but the real size at a zero budget (the sweep shape)', () => {
    expect(sliceText('hello', 0)).toEqual({
      text: '',
      chars: 0,
      offset: 0,
      totalChars: 5,
      truncated: true,
    })
  })

  it('marks a body that fits as untruncated, and never pads past the end', () => {
    expect(sliceText('hi', 100)).toEqual({
      text: 'hi',
      chars: 2,
      offset: 0,
      totalChars: 2,
      truncated: false,
    })
    expect(sliceText('', 10)).toEqual({
      text: '',
      chars: 0,
      offset: 0,
      totalChars: 0,
      truncated: false,
    })
  })

  it('windows from an offset, so the middle and tail of a large body are reachable', () => {
    expect(sliceText('0123456789', 4, 2)).toEqual({
      text: '2345',
      chars: 4,
      offset: 2,
      totalChars: 10,
      truncated: true,
    })
    // The final window: still truncated (the head is missing), and never padded.
    expect(sliceText('0123456789', 100, 8)).toEqual({
      text: '89',
      chars: 2,
      offset: 8,
      totalChars: 10,
      truncated: true,
    })
    // Past the end: empty, with the offset clamped so `offset + chars <= totalChars` holds.
    expect(sliceText('0123456789', 4, 50)).toEqual({
      text: '',
      chars: 0,
      offset: 10,
      totalChars: 10,
      truncated: true,
    })
  })

  it('counts and cuts in code points, never splitting a surrogate pair', () => {
    // Four emoji: 4 code points, 8 UTF-16 units. The budget is code points (the SQL unit).
    expect(sliceText('😀😀😀😀', 2)).toEqual({
      text: '😀😀',
      chars: 2,
      offset: 0,
      totalChars: 4,
      truncated: true,
    })
    expect(sliceText('😀😀', 10)).toEqual({
      text: '😀😀',
      chars: 2,
      offset: 0,
      totalChars: 2,
      truncated: false,
    })
    // An OFFSET walks code points too: starting at 1 must skip the whole first emoji, not
    // land inside its surrogate pair.
    expect(sliceText('😀ab', 2, 1)).toEqual({
      text: 'ab',
      chars: 2,
      offset: 1,
      totalChars: 3,
      truncated: true,
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
      offset: 0,
      totalChars: 40,
      truncated: true,
    })
  })

  it('reports the window start the store sliced at, clamped to the body', () => {
    expect(toDebugText({ text: 'cde', totalChars: 40 }, 2)).toMatchObject({
      offset: 2,
      truncated: true,
    })
    // An ask past the end reports where the body actually stops, not the fiction asked for.
    expect(toDebugText({ text: '', totalChars: 40 }, 90).offset).toBe(40)
  })

  it("passes a search's per-body match offset through, keeping null and absent distinct", () => {
    // null = searched, no match in THIS body; absent = no search ran. Collapsing them would
    // make an unsearched page read as "searched everything, found nothing".
    expect(toDebugText({ text: '', totalChars: 40, matchOffset: 7 }).matchOffset).toBe(7)
    expect(toDebugText({ text: '', totalChars: 40, matchOffset: null }).matchOffset).toBeNull()
    expect('matchOffset' in toDebugText({ text: '', totalChars: 40 })).toBe(false)
  })

  it('measures the returned slice in code points, matching the SQL total', () => {
    // A body of 10 emoji cut by SQL to 5: `.length` of the slice is 10 UTF-16 units, which
    // EQUALS the code-point total — a unit mix here read a halved body as untruncated.
    expect(toDebugText({ text: '😀😀😀😀😀', totalChars: 10 })).toEqual({
      text: '😀😀😀😀😀',
      chars: 5,
      offset: 0,
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
    phase: 'agent',
    turnIndex: null,
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

  it('carries the phase and turn axes through, without inventing either', () => {
    expect(toDebugLlmCall(call)).toMatchObject({ phase: 'agent', turnIndex: null })
    expect(toDebugLlmCall({ ...call, phase: 'validation-repair', turnIndex: 7 })).toMatchObject({
      phase: 'validation-repair',
      turnIndex: 7,
    })
    // The unattributed slice stays '' rather than being dressed up as a named phase, and a
    // turn-less channel stays null rather than being faked into "turn 0".
    const unattributed = toDebugLlmCall({ ...call, phase: '', turnIndex: null })
    expect(unattributed.phase).toBe('')
    expect(unattributed.turnIndex).toBeNull()
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
    const { totals, byAgentKind, byPhase } = foldLlmRollup([])
    expect(totals.calls).toBe(0)
    expect(totals.cacheHitRate).toBeNull()
    expect(totals.transportOverheadRatio).toBeNull()
    expect(byAgentKind).toEqual([])
    expect(byPhase).toEqual([])
  })

  it('cuts the same cells by phase, costliest carry cost first, and shares that sum to 1', () => {
    const { totals, byAgentKind, byPhase } = foldLlmRollup([
      summary({ agentKind: 'coder', phase: 'agent', calls: 5, carryCostTokens: 100 }),
      summary({
        agentKind: 'coder',
        phase: 'validation-repair',
        calls: 2,
        carryCostTokens: 700,
      }),
      summary({ agentKind: 'tester', phase: 'agent', calls: 3, carryCostTokens: 200 }),
    ])
    // The breakdown a caller asking "why did this trivial task cost a million tokens" needs:
    // `byAgentKind` cannot answer it, because one coder step contains every phase.
    expect(byPhase.map((p) => [p.phase, p.calls, p.carryCostTokens])).toEqual([
      ['validation-repair', 2, 700],
      ['agent', 8, 300],
    ])
    expect(byPhase.reduce((a, p) => a + (p.carryCostShare ?? 0), 0)).toBeCloseTo(1)
    // Both axes are folds over ONE aggregate, so neither can drift from the totals above them.
    expect(byPhase.reduce((a, p) => a + p.calls, 0)).toBe(totals.calls)
    expect(byAgentKind.reduce((a, k) => a + k.calls, 0)).toBe(totals.calls)
  })

  it("keeps the unattributed '' phase as a row instead of hiding it", () => {
    // A run metered by a channel with no phase concept must not read as a run that spent
    // nothing outside the agent — the table would look complete while under-reporting.
    const { byPhase } = foldLlmRollup([summary({ phase: '', calls: 4 })])
    expect(byPhase.map((p) => [p.phase, p.calls])).toEqual([['', 4]])
  })

  it('reports a null carry-cost share rather than a divide-by-zero when nothing carried', () => {
    const { byPhase } = foldLlmRollup([summary({ carryCostTokens: 0 })])
    expect(byPhase[0]!.carryCostShare).toBeNull()
  })
})

describe('deriveSignals', () => {
  const base = {
    steps: [],
    ...foldLlmRollup([]),
    sinks: EMPTY_SINKS,
    provisioningFailures: 0,
    toolCells: [],
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

  it('points a failed run with clean model calls at tool execution, naming both reads', () => {
    // The signature the skill's step-3 rule names: every call ok, none truncated, run dead —
    // the failure happened in tool EXECUTION (or the engine), neither of which the LLM rollup
    // this signal is computed from can see. Without it the overview reads like a healthy run
    // that inexplicably died. The pointer names the trajectory first (where a failing tool call
    // IS a row) and keeps the delta search behind it for what no producer records.
    const signals = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      ...foldLlmRollup([summary({ calls: 40, errors: 0, truncatedCalls: 0 })]),
      sinks: { ...EMPTY_SINKS, toolCalls: { available: true, count: 12 } },
      toolCells: [{ agentKind: 'coder', tool: 'edit', calls: 12, failures: 3 }],
    })
    const pointer = signals.find((s) => s.code === 'failure_outside_model_calls')
    expect(pointer).toMatchObject({ severity: 'warning', count: 40 })
    // Failing tool calls exist, so the pointer says so and sends the reader at the rows.
    expect(pointer!.message).toContain('tool-calls?outcome=error')

    // Any model-side anomaly claims the diagnosis instead: the pointer must not fire beside
    // a failed call…
    const withErrors = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      ...foldLlmRollup([summary({ calls: 40, errors: 1 })]),
    })
    expect(withErrors.map((s) => s.code)).not.toContain('failure_outside_model_calls')
    // …or a truncated one, and never on a run that did not fail, or that made no calls at all
    // (`no_model_calls` owns that shape).
    const truncated = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      ...foldLlmRollup([summary({ calls: 40, truncatedCalls: 2 })]),
    })
    expect(truncated.map((s) => s.code)).not.toContain('failure_outside_model_calls')
    const healthy = deriveSignals({
      ...base,
      execution: run({ status: 'done' }),
      ...foldLlmRollup([summary({ calls: 40 })]),
    })
    expect(healthy.map((s) => s.code)).not.toContain('failure_outside_model_calls')
    const noCalls = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      ...foldLlmRollup([]),
    })
    expect(noCalls.map((s) => s.code)).not.toContain('failure_outside_model_calls')
  })

  it('distinguishes an unrecorded tool loop from a recorded one that failed nothing', () => {
    // The two look identical in every count on the overview and mean opposite things: one is
    // "the container's work was not captured", the other is "the container's work was fine, so
    // look at the engine". Collapsing them sends a debugger past the evidence they need.
    const failedRun = { ...base, execution: run({ status: 'failed' }) }
    const rollup = foldLlmRollup([summary({ calls: 40 })])

    const clean = deriveSignals({
      ...failedRun,
      ...rollup,
      sinks: { ...EMPTY_SINKS, toolCalls: { available: true, count: 12 } },
      toolCells: [{ agentKind: 'coder', tool: 'edit', calls: 12, failures: 0 }],
    })
    const cleanMessage = clean.find((s) => s.code === 'failure_outside_model_calls')!.message
    expect(cleanMessage).toContain('points at the engine')
    expect(cleanMessage).not.toContain('outcome=error')

    const unwired = deriveSignals({
      ...failedRun,
      ...rollup,
      sinks: { ...EMPTY_SINKS, toolCalls: { available: false, count: 0 } },
    })
    const unwiredMessage = unwired.find((s) => s.code === 'failure_outside_model_calls')!.message
    expect(unwiredMessage).toContain('not wired on this deployment')
    expect(unwiredMessage).not.toContain('points at the engine')

    // Wired but holding nothing for this run is the same absence with a different cause, so it
    // states the absence without blaming the deployment's wiring for it.
    const empty = deriveSignals({ ...failedRun, ...rollup })
    const emptyMessage = empty.find((s) => s.code === 'failure_outside_model_calls')!.message
    expect(emptyMessage).toContain('unrecorded rather than uneventful')
    expect(emptyMessage).not.toContain('not wired on this deployment')
  })

  it('counts tool-EXECUTION failures, which every LLM rollup beside them reports as healthy', () => {
    const signals = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [
        { agentKind: 'coder', tool: 'bash', calls: 30, failures: 2 },
        { agentKind: 'coder', tool: 'edit', calls: 10, failures: 2 },
      ],
    })
    const failed = signals.find((s) => s.code === 'tool_calls_failed')
    // `info`, not `warning`: a failing tool call is the ordinary shape of an agent loop (a test
    // that fails before it is fixed, a `grep` that matches nothing), so a warning here would fire
    // on most healthy runs and cost the severity ordering the thing it exists for. The count is
    // context; `tool_retry_loop` is the diagnosis.
    expect(failed).toMatchObject({ severity: 'info', count: 4 })
    expect(failed!.message).toContain('10%')
    expect(failed!.message).toContain('outcome=error')
    // Scattered failures are NOT a retry loop: no cell is mostly-failing, so the sharper
    // finding must not fire on a shape that does not have it.
    expect(signals.map((s) => s.code)).not.toContain('tool_retry_loop')
    // A run whose tools all worked says nothing at all rather than a reassuring zero row.
    const healthy = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [{ agentKind: 'coder', tool: 'bash', calls: 30, failures: 0 }],
    })
    expect(healthy.map((s) => s.code)).not.toContain('tool_calls_failed')
  })

  it('names the (agentKind, tool) pair a retry loop concentrated on', () => {
    // The finding is the CONCENTRATION, which both of the overview's breakdowns have folded
    // away by the time a reader sees them.
    const signals = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [
        { agentKind: 'coder', tool: 'bash', calls: 100, failures: 3 },
        { agentKind: 'ci-fixer', tool: 'apply_patch', calls: 9, failures: 8 },
      ],
    })
    const loop = signals.find((s) => s.code === 'tool_retry_loop')
    expect(loop).toMatchObject({ severity: 'warning', count: 8, agentKind: 'ci-fixer' })
    expect(loop!.message).toContain('apply_patch')
    // The drill-down it hands the reader must be a query the endpoint still takes. An unknown
    // param is IGNORED rather than refused, so a stale spelling here does not fail anywhere: it
    // silently answers with the whole trajectory, which a follower reads as all-failures. This
    // signal shipped with `?ok=false` for a release after that param was replaced.
    expect(loop!.message).toContain('order=trajectory&outcome=error')

    // Both conditions are load-bearing. A single failing command is not a loop…
    const oneFailure = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [{ agentKind: 'coder', tool: 'bash', calls: 1, failures: 1 }],
    })
    expect(oneFailure.map((s) => s.code)).not.toContain('tool_retry_loop')
    // …and neither is a thorough agent whose many calls mostly worked.
    const busy = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [{ agentKind: 'coder', tool: 'bash', calls: 400, failures: 20 }],
    })
    expect(busy.map((s) => s.code)).not.toContain('tool_retry_loop')
  })

  it('finds the loop behind a busier cell that carries more raw failures', () => {
    // A coder running tests that fail is not a loop and outranks the wedged fixer on failure
    // COUNT, so the loop is only found by testing every cell rather than the top-ranked one.
    // The run this fires on is the motivating case for the whole sink.
    const signals = deriveSignals({
      ...base,
      execution: run({ status: 'failed' }),
      toolCells: [
        { agentKind: 'coder', tool: 'bash', calls: 100, failures: 6 },
        { agentKind: 'ci-fixer', tool: 'apply_patch', calls: 5, failures: 5 },
      ],
    })
    expect(signals.find((s) => s.code === 'tool_retry_loop')).toMatchObject({
      agentKind: 'ci-fixer',
      count: 5,
    })
  })

  it('orders the tool diagnosis above the tool count, as their severities say', () => {
    // The list is read top-down and truncated by callers, so a `warning` that names where to look
    // must not sit under the `info` that merely counts.
    const codes = deriveSignals({
      ...base,
      execution: run(),
      toolCells: [{ agentKind: 'ci-fixer', tool: 'apply_patch', calls: 6, failures: 6 }],
    }).map((s) => s.code)
    expect(codes.indexOf('tool_retry_loop')).toBeLessThan(codes.indexOf('tool_calls_failed'))
  })
})

describe('foldToolCallRollup', () => {
  it('re-cuts one aggregate along both axes, each row carrying the ratio it means something as', () => {
    const rollup = foldToolCallRollup([
      { agentKind: 'coder', tool: 'edit', calls: 6, failures: 5 },
      { agentKind: 'coder', tool: 'bash', calls: 30, failures: 1 },
      { agentKind: 'ci-fixer', tool: 'edit', calls: 4, failures: 0 },
    ])
    expect(rollup.totals).toEqual({ calls: 40, failures: 6, failureRate: 0.15 })
    expect(rollup.byTool).toEqual([
      { tool: 'edit', calls: 10, failures: 5, failureRate: 0.5 },
      { tool: 'bash', calls: 30, failures: 1, failureRate: 1 / 30 },
    ])
    expect(rollup.byAgentKind.map((row) => row.agentKind)).toEqual(['coder', 'ci-fixer'])
    // Both breakdowns fold the same cells, so neither can drift from the totals above it.
    for (const axis of [rollup.byTool, rollup.byAgentKind]) {
      expect(axis.reduce((acc, row) => acc + row.calls, 0)).toBe(rollup.totals.calls)
      expect(axis.reduce((acc, row) => acc + row.failures, 0)).toBe(rollup.totals.failures)
    }
  })

  it('reports a NULL failure rate for a run that called no tools', () => {
    // Not 0%, which would file "nothing happened" beside "everything worked".
    expect(foldToolCallRollup([])).toEqual({
      totals: { calls: 0, failures: 0, failureRate: null },
      byTool: [],
      byAgentKind: [],
    })
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
      offset: 0,
      totalChars: 13,
      truncated: true,
    })
    expect(detail.userPrompt.text).toBe('USER')
    expect(detail.fragments[0]!.body.totalChars).toBe(50)
    // The file AFTER the 10 kB one still gets its own budget, and fits within it.
    expect(detail.contextFiles[1]!.content).toEqual({
      text: 'zz',
      chars: 2,
      offset: 0,
      totalChars: 2,
      truncated: false,
    })
    expect(detail.extras).toEqual({ branch: 'main' })
  })
})
