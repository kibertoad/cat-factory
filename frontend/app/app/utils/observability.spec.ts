import { describe, it, expect } from 'vitest'
import type {
  AgentFailure,
  AgentToolCall,
  LlmCallMetric,
  PipelineStep,
  RunToolCallFailures,
  StepPhaseMetrics,
} from '~/types/execution'
import type { SinkAnswer } from './observability'
import {
  countCallOutcomes,
  deriveRunFailureEvidence,
  filterCallsByOutcome,
  filterToolCallsByOutcome,
  foldRunPhaseMetrics,
  formatCost,
  hasFailureEvidence,
  noFailingCallReason,
  sinkAnswer,
  sumCosts,
  totalInputTokens,
} from './observability'

describe('totalInputTokens', () => {
  it('sums all three input classes, so the headline matches Claude Code’s context gauge', () => {
    expect(
      totalInputTokens({ promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }),
    ).toBe(31_100_498)
  })

  it('counts cache WRITES too — they occupy the window like any other input token', () => {
    expect(
      totalInputTokens({ promptTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 40 }),
    ).toBe(1040)
  })

  it('does NOT lead with the fresh figure on a cache-dominated run', () => {
    // The regression this pins: leading with fresh made a ~31M-token run render as 685 tokens,
    // discounting cache reads because their dollar cost is low. Volume is the thing being
    // measured here, and a cached token costs the same context window as a fresh one.
    const m = { promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }
    expect(totalInputTokens(m)).toBeGreaterThan(m.promptTokens * 1000)
  })

  it('degrades to the fresh count when an older snapshot carries no cache fields', () => {
    expect(totalInputTokens({ promptTokens: 500 })).toBe(500)
  })
})

describe('foldRunPhaseMetrics', () => {
  const phase = (over: Partial<StepPhaseMetrics> & Pick<StepPhaseMetrics, 'phase'>) => ({
    calls: 1,
    promptTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 5,
    carryCostTokens: 0,
    errors: 0,
    ...over,
  })
  const step = (agentKind: string, byPhase: StepPhaseMetrics[]) =>
    ({ agentKind, metrics: { byPhase } }) as unknown as PipelineStep

  it('does NOT double-count two steps that share an agent kind', () => {
    // A step's rollup covers its agent KIND across the whole run (the proxy keys a conversation
    // by `(execution, agentKind)`), so two tester steps carry identical numbers. Summing them
    // would report twice the tokens the run actually spent.
    const rows = [phase({ phase: 'agent', calls: 3, carryCostTokens: 90 })]
    const folded = foldRunPhaseMetrics([step('tester', rows), step('tester', rows)])
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ phase: 'agent', calls: 3, carryCostTokens: 90 })
  })

  it('merges a phase across different agent kinds and sorts costliest first', () => {
    const folded = foldRunPhaseMetrics([
      step('coder', [
        phase({ phase: 'agent', calls: 2, carryCostTokens: 10 }),
        phase({ phase: 'validation-repair', calls: 1, carryCostTokens: 500 }),
      ]),
      step('reviewer', [phase({ phase: 'agent', calls: 4, carryCostTokens: 40 })]),
    ])
    expect(folded.map((p) => [p.phase, p.calls, p.carryCostTokens])).toEqual([
      ['validation-repair', 1, 500],
      ['agent', 6, 50],
    ])
  })

  it("keeps the unattributed '' phase rather than hiding it", () => {
    const folded = foldRunPhaseMetrics([step('coder', [phase({ phase: '', calls: 7 })])])
    expect(folded.map((p) => p.phase)).toEqual([''])
  })

  it('is empty when no step carries a rollup, so the section simply does not render', () => {
    expect(foldRunPhaseMetrics([{ agentKind: 'coder' } as unknown as PipelineStep])).toEqual([])
  })

  it('returns fresh rows rather than aliasing the store objects it folded', () => {
    // The single-kind case is the one that used to pass a `step.metrics.byPhase` row straight
    // through: a caller mutating what a fold handed it would have written into the store.
    const row = phase({ phase: 'agent', calls: 3, carryCostTokens: 90 })
    const folded = foldRunPhaseMetrics([step('coder', [row])])
    expect(folded[0]).not.toBe(row)
    folded[0]!.calls = 999
    expect(row.calls).toBe(3)
  })
})

describe('formatCost', () => {
  it('omits the figure entirely when nothing priced it', () => {
    // Null, never "0.00": a deployment that cannot price a model and a step that cost nothing
    // are opposite facts, and rendering both as zero states the wrong one confidently.
    expect(formatCost(null, 'EUR')).toBeNull()
    expect(formatCost(undefined, 'EUR')).toBeNull()
    // A genuine zero still renders — it is a real, priced answer.
    expect(formatCost(0, 'EUR')).toBe('0.00 EUR')
  })

  it('keeps more decimals under a unit, where most steps land', () => {
    expect(formatCost(0.0037, 'EUR')).toBe('0.0037 EUR')
    expect(formatCost(12.5, 'EUR')).toBe('12.50 EUR')
  })

  it('shows a threshold rather than rounding a real cost down to zero', () => {
    // `0.0000` makes a priced-but-tiny step read as free — the same claim the null case is
    // careful not to make. A cheap step is not a free one.
    expect(formatCost(0.00001, 'EUR')).toBe('<0.0001 EUR')
    expect(formatCost(0.0001, 'EUR')).toBe('0.0001 EUR')
  })

  it('labels the amount with the currency it was priced in rather than assuming one', () => {
    // The price table's currency is operator-configured; the built-in one is EUR, not USD.
    expect(formatCost(1, 'USD')).toBe('1.00 USD')
    expect(formatCost(1)).toBe('1.00')
  })
})

describe('sumCosts', () => {
  it('adds the parts it can price', () => {
    expect(sumCosts([1, 2, 0.5])).toBe(3.5)
    expect(sumCosts([])).toBe(0)
  })

  it('declines to answer when any part is unpriced, rather than under-reporting', () => {
    // A total that silently dropped its unpriceable term is a smaller number that still reads
    // as complete — strictly worse than no number.
    expect(sumCosts([1, null, 2])).toBeNull()
    expect(sumCosts([undefined])).toBeNull()
  })
})

describe('failing-call-first triage', () => {
  const call = (over: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric =>
    ({
      workspaceId: 'ws',
      executionId: 'run',
      agentKind: 'coder',
      provider: 'anthropic',
      model: 'm',
      createdAt: 1,
      streaming: false,
      phase: 'agent',
      turnIndex: null,
      messageCount: 1,
      toolCount: 0,
      requestMaxTokens: null,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      finishReason: 'stop',
      upstreamMs: 1,
      overheadMs: 1,
      totalMs: 2,
      ok: true,
      httpStatus: 200,
      errorMessage: null,
      promptText: '',
      promptPrefixCount: 0,
      promptHash: '',
      responseText: '',
      reasoningText: '',
      ...over,
    }) as LlmCallMetric

  const tool = (over: Partial<AgentToolCall> & Pick<AgentToolCall, 'id'>): AgentToolCall => ({
    workspaceId: 'ws',
    executionId: 'run',
    agentKind: 'coder',
    jobId: 'job',
    seq: 0,
    tool: 'bash',
    startedAt: 1,
    endedAt: 2,
    ok: true,
    bodies: 'stored',
    args: '',
    result: '',
    argsDropped: 0,
    resultDropped: 0,
    createdAt: 1,
    ...over,
  })

  /** An untruncated failure read holding exactly these rows: the ordinary case. */
  const toolFailures = (
    failures: AgentToolCall[],
    total = failures.length,
  ): RunToolCallFailures => ({
    total,
    failed: failures.length,
    failures,
    failuresTruncated: false,
  })

  const failure = (): AgentFailure => ({
    kind: 'agent',
    message: 'the coder step failed',
    detail: null,
    hint: null,
    occurredAt: 5,
    lastSubtasks: null,
  })

  describe('countCallOutcomes', () => {
    it('keeps a failed call and a TRUNCATED one in different buckets', () => {
      // They need different fixes (transport/proxy/spend versus an output limit), so a filter
      // that lumped them together would send an operator to the wrong conversation.
      const counts = countCallOutcomes([
        call({ id: 'a' }),
        call({ id: 'b', ok: false, finishReason: null }),
        call({ id: 'c', finishReason: 'length' }),
        call({ id: 'd', finishReason: 'content_filter' }),
      ])
      expect(counts).toEqual({ all: 4, ok: 1, warning: 2, error: 1 })
    })

    it('counts a failed call as an error even when its finish reason looks like a warning', () => {
      // `ok: false` wins: a call that failed AND reported `length` is a failure, not a
      // truncation, and counting it in both buckets would make the chips sum past the total.
      const counts = countCallOutcomes([call({ id: 'a', ok: false, finishReason: 'length' })])
      expect(counts).toEqual({ all: 1, ok: 0, warning: 0, error: 1 })
    })
  })

  describe('filterCallsByOutcome', () => {
    const calls = [
      call({ id: 'ok' }),
      call({ id: 'warn', finishReason: 'length' }),
      call({ id: 'err', ok: false }),
    ]

    it('narrows to one class and passes everything through on `all`', () => {
      expect(filterCallsByOutcome(calls, 'error').map((c) => c.id)).toEqual(['err'])
      expect(filterCallsByOutcome(calls, 'warning').map((c) => c.id)).toEqual(['warn'])
      expect(filterCallsByOutcome(calls, 'all').map((c) => c.id)).toEqual(['ok', 'warn', 'err'])
    })

    it('returns a fresh array, never the caller’s own list', () => {
      // The panel holds the store's array; a filter that aliased it on `all` would let a sort in
      // the component reorder the store.
      expect(filterCallsByOutcome(calls, 'all')).not.toBe(calls)
    })
  })

  describe('filterToolCallsByOutcome', () => {
    it('narrows a trajectory to the failing calls, keeping their order', () => {
      const trajectory = [
        tool({ id: '1' }),
        tool({ id: '2', ok: false }),
        tool({ id: '3' }),
        tool({ id: '4', ok: false }),
      ]
      expect(filterToolCallsByOutcome(trajectory, 'error').map((c) => c.id)).toEqual(['2', '4'])
      expect(filterToolCallsByOutcome(trajectory, 'ok').map((c) => c.id)).toEqual(['1', '3'])
      expect(filterToolCallsByOutcome(trajectory, 'all')).toHaveLength(4)
    })
  })

  describe('deriveRunFailureEvidence', () => {
    /** Both sinks answered with the given rows. */
    const answered = (rows: number): SinkAnswer => ({ status: 'answered', rows })
    const evidenceFor = (input: {
      failure?: AgentFailure | null
      calls?: LlmCallMetric[]
      toolFailures?: RunToolCallFailures | null
    }) => {
      const calls = input.calls ?? []
      const toolFailures = input.toolFailures ?? null
      return deriveRunFailureEvidence({
        failure: input.failure ?? null,
        calls,
        callsAnswer: answered(calls.length),
        toolFailures,
        toolsAnswer: toolFailures ? answered(toolFailures.total) : { status: 'pending' },
      })
    }

    it('picks the LAST failing row from each sink, respecting their opposite orders', () => {
      // Calls arrive newest-first; the failing tool calls arrive oldest-first (trajectory order).
      // Reading either the wrong way round still yields a failing call, just not the one nearest
      // the failure, which is the only reason to pin one.
      const evidence = evidenceFor({
        failure: failure(),
        calls: [
          call({ id: 'newest-error', ok: false, createdAt: 30 }),
          call({ id: 'older-error', ok: false, createdAt: 10 }),
        ],
        toolFailures: toolFailures([
          tool({ id: 'oldest-fail', ok: false, startedAt: 10 }),
          tool({ id: 'latest-fail', ok: false, startedAt: 30 }),
        ]),
      })
      expect(evidence.lastErroredCall?.id).toBe('newest-error')
      expect(evidence.lastFailedToolCall?.id).toBe('latest-fail')
      expect(evidence.erroredCallCount).toBe(2)
      expect(evidence.failedToolCallCount).toBe(2)
    })

    it('counts failing tool calls off the run AGGREGATE, never off the rows it holds', () => {
      // The failure this split exists to prevent. The backend narrows and counts over the whole
      // run; the rows come back bounded. A count taken from the list would under-report exactly
      // the long runs worth opening the panel for, and would disagree with the debug overview's
      // `toolCalls.totals.failures` on the same run.
      const evidence = evidenceFor({
        failure: failure(),
        toolFailures: {
          total: 5_000,
          failed: 240,
          failures: [tool({ id: 'held', ok: false })],
          failuresTruncated: true,
        },
      })
      expect(evidence.failedToolCallCount).toBe(240)
      expect(evidence.failedToolCallsTruncated).toBe(true)
      expect(evidence.lastFailedToolCall?.id).toBe('held')
    })

    it('reports a run whose model calls are all healthy but whose tools are not', () => {
      // The whole failure class this surface exists for: the model call that requested the tool
      // still reports `ok`, so every LLM rollup reads clean.
      const evidence = evidenceFor({
        failure: failure(),
        calls: [call({ id: 'fine' })],
        toolFailures: toolFailures([tool({ id: 'broke', ok: false })]),
      })
      expect(evidence.lastErroredCall).toBeNull()
      expect(evidence.lastFailedToolCall?.id).toBe('broke')
      expect(hasFailureEvidence(evidence)).toBe(true)
    })

    it('has nothing to pin for a run that neither failed nor recorded a failing call', () => {
      expect(hasFailureEvidence(evidenceFor({ calls: [call({ id: 'a' })] }))).toBe(false)
    })

    it('pins the section for an UNREACHABLE sink even with no failure and no failing call', () => {
      // "One of these reads did not come back" has to reach the operator before they read the
      // rest of the page as whole. Staying silent is how the other numbers get believed.
      const evidence = deriveRunFailureEvidence({
        failure: null,
        calls: [],
        callsAnswer: { status: 'answered', rows: 0 },
        toolFailures: null,
        toolsAnswer: { status: 'unreachable' },
      })
      expect(hasFailureEvidence(evidence)).toBe(true)
    })
  })

  describe('sinkAnswer', () => {
    it('reports an in-flight read as pending whatever it is still holding', () => {
      // A refresh over a previous answer (or a previous error) is not that answer: what the panel
      // says next depends on what is coming back.
      expect(sinkAnswer({ loading: true, error: 'boom', loaded: true, rows: 3 })).toEqual({
        status: 'pending',
      })
    })

    it('separates a failed read from an answer of zero rows', () => {
      expect(sinkAnswer({ loading: false, error: 'boom', loaded: false, rows: 0 })).toEqual({
        status: 'unreachable',
      })
      expect(sinkAnswer({ loading: false, error: null, loaded: true, rows: 0 })).toEqual({
        status: 'answered',
        rows: 0,
      })
    })

    it('treats never-requested as pending, not as an answer', () => {
      expect(sinkAnswer({ loading: false, error: null, loaded: false, rows: 0 })).toEqual({
        status: 'pending',
      })
    })
  })

  describe('noFailingCallReason', () => {
    const reasonFor = (calls: SinkAnswer, tools: SinkAnswer, failed = 0) =>
      noFailingCallReason(
        deriveRunFailureEvidence({
          failure: failure(),
          calls: [],
          callsAnswer: calls,
          toolFailures: { total: 0, failed, failures: [], failuresTruncated: false },
          toolsAnswer: tools,
        }),
      )
    const answered = (rows: number): SinkAnswer => ({ status: 'answered', rows })

    it('says nothing when a failing call WAS found', () => {
      expect(reasonFor(answered(1), answered(1), 1)).toBeNull()
    })

    it('distinguishes "both sinks answered and nothing failed" from "nothing was recorded"', () => {
      // The distinction the whole helper exists for: an unwired sink, a capture opt-out and a
      // container that died before reporting all produce zero failing rows, exactly like a run
      // whose every call succeeded, and only one of those is a clean bill of health.
      expect(reasonFor(answered(1), answered(1))).toBe('recorded-clean')
      expect(reasonFor(answered(0), answered(0))).toBe('no-telemetry')
    })

    it('names WHICH sink is empty when only one holds rows', () => {
      expect(reasonFor(answered(1), answered(0))).toBe('partial-calls-only')
      expect(reasonFor(answered(0), answered(1))).toBe('partial-tools-only')
    })

    it('withholds every verdict while a sink has not answered yet', () => {
      // A read still in flight is not a read that came back clean, and rendering it as one is a
      // clean bill of health written before the evidence arrived.
      expect(reasonFor({ status: 'pending' }, answered(1))).toBeNull()
      expect(reasonFor(answered(1), { status: 'pending' })).toBeNull()
    })

    it('lets an UNREACHABLE sink outrank every statement about the run', () => {
      // Each other reason is a claim about the run. This is the one case where the panel has no
      // standing to make one, so it must win even against a sink that answered richly.
      expect(reasonFor({ status: 'unreachable' }, answered(9))).toBe('sink-unreachable')
      expect(reasonFor(answered(9), { status: 'unreachable' })).toBe('sink-unreachable')
    })
  })
})
