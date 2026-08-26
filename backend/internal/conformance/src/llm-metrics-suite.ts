import type {
  HarnessCallMetric,
  InlineLlmCall,
  LlmCallMetric,
  LlmCallMetricRepository,
} from '@cat-factory/kernel'
import { foldRollupsByPhase } from '@cat-factory/kernel'
import {
  LlmObservabilityService,
  makeHarnessCallRecorder,
  makeInlineCallRecorder,
} from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the LLM observability sink. The proxy that records these
// metrics is runtime-neutral, but each facade persists them in its own store (D1 on
// Cloudflare, Drizzle/Postgres on Node). This suite drives the SAME record → list →
// summarize → prune assertions through whichever real repository a runtime hands it,
// so a column mapped differently or an aggregate computed differently fails a test
// instead of shipping. Both runtimes invoke it over their real database.

/** Build a fully-specified metric, overriding only what a case cares about. */
function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    spendOnly: false,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 30,
    totalMs: 230,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link LlmCallMetricRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids are unique
 * per run so the shared database stays isolated between cases.
 */
/** Unique workspace/execution ids per case, so the shared DB cannot bleed across tests. */
interface MetricIds {
  ws: string
  e1: string
  e2: string
}

export function defineLlmMetricsSuite(name: string, makeRepo: () => LlmCallMetricRepository): void {
  describe(`[${name}] llm metrics repository parity`, () => {
    // Unique workspace/execution per case so the shared DB doesn't bleed across tests.
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    registerMetricRollupTests(makeRepo, ids)
    registerMetricProducerTests(makeRepo, ids)
    registerMetricDebugReadTests(makeRepo, ids)
    registerMetricRunPageTests(makeRepo, ids)
    registerMetricBatchTests(makeRepo, ids)
  })
}

/**
 * Recording a call and reading it back: newest-first per execution, the reasoning trace, the
 * prompt-delta chain tip, and the per-(agentKind, phase) rollup every coarser view folds over.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMetricRollupTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it('records calls and lists them newest-first per execution', async () => {
    const repo = makeRepo()
    const { ws, e1, e2 } = ids()
    await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
    await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 30 }))
    await repo.record(metric({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))
    await repo.record(metric({ id: `${ws}-d`, workspaceId: ws, executionId: e2, createdAt: 99 }))

    const calls = await repo.listByExecution(ws, e1)
    expect(calls.map((c) => c.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
    // The other execution's call is excluded.
    expect((await repo.listByExecution(ws, e2)).map((c) => c.id)).toEqual([`${ws}-d`])
    // Round-trips the full record (incl. the heavy text columns + nullable fields).
    const first = calls[0]!
    expect(first.responseText).toBe('ok')
    expect(first.streaming).toBe(false)
    expect(first.requestMaxTokens).toBe(1000)
  })

  it('round-trips the reasoning trace (a thinking model with empty response text)', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // The signature this column exists for: output tokens spent, but no response text —
    // the thinking trace is the only record of what those tokens produced.
    await repo.record(
      metric({
        id: `${ws}-r`,
        workspaceId: ws,
        executionId: e1,
        completionTokens: 17856,
        finishReason: 'stop',
        responseText: '',
        reasoningText: 'Let me work through the spec…',
      }),
    )
    const stored = (await repo.listByExecution(ws, e1))[0]!
    expect(stored.responseText).toBe('')
    expect(stored.reasoningText).toBe('Let me work through the spec…')
  })

  it('round-trips the delta prompt fields and reports the newest chain tip', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // No calls yet ⇒ no chain tip.
    expect(await repo.latestChainTip(ws, e1, 'coder')).toBeNull()

    await repo.record(
      metric({
        id: `${ws}-1`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 10,
        messageCount: 2,
        promptText: '[{"role":"system"},{"role":"user"}]',
        promptPrefixCount: 0,
        promptHash: 'h1',
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-2`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 20,
        messageCount: 4,
        promptText: '[{"role":"assistant"},{"role":"tool"}]',
        promptPrefixCount: 2,
        promptHash: 'h2',
      }),
    )

    // The tip is the newest call for the (ws, execution, kind) chain.
    expect(await repo.latestChainTip(ws, e1, 'coder')).toEqual({
      messageCount: 4,
      promptHash: 'h2',
    })
    // A different agent kind has its own (empty) chain.
    expect(await repo.latestChainTip(ws, e1, 'reviewer')).toBeNull()

    // The delta fields survive the round-trip.
    const stored = (await repo.listByExecution(ws, e1)).find((c) => c.id === `${ws}-2`)!
    expect(stored.promptPrefixCount).toBe(2)
    expect(stored.promptHash).toBe('h2')
    expect(stored.promptText).toBe('[{"role":"assistant"},{"role":"tool"}]')
  })

  it('summarizes per agent-kind: tokens, cached tokens, peak, headroom, truncation, errors, warnings', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // ok stop, truncated (length → warning), and a failed call — same agent kind.
    await repo.record(
      metric({
        id: `${ws}-1`,
        workspaceId: ws,
        executionId: e1,
        promptTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 15,
        completionTokens: 50,
        requestMaxTokens: 1000,
        upstreamMs: 100,
        overheadMs: 10,
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-2`,
        workspaceId: ws,
        executionId: e1,
        promptTokens: 100,
        cacheReadTokens: 60,
        cacheWriteTokens: 25,
        completionTokens: 990,
        requestMaxTokens: 1000,
        finishReason: 'length',
        upstreamMs: 200,
        overheadMs: 20,
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-3`,
        workspaceId: ws,
        executionId: e1,
        ok: false,
        httpStatus: 502,
        finishReason: null,
        completionTokens: 0,
        upstreamMs: 5,
        overheadMs: 5,
      }),
    )

    const summaries = await repo.summarizeByExecution(ws, e1)
    expect(summaries).toHaveLength(1)
    const s = summaries[0]!
    expect(s.agentKind).toBe('coder')
    expect(s.phase).toBe('agent')
    expect(s.calls).toBe(3)
    // The two cache classes are aggregated APART: a lumped sum cannot tell a run riding a
    // warm cache from one re-writing its prefix, and they are priced an order of magnitude
    // apart (~0.1x vs 1.25-2x base input).
    expect(s.cacheReadTokens).toBe(100)
    expect(s.cacheWriteTokens).toBe(40)
    expect(s.completionTokens).toBe(1040)
    expect(s.peakCompletionTokens).toBe(990)
    expect(s.maxOutputTokens).toBe(1000)
    expect(s.truncatedCalls).toBe(1)
    expect(s.errors).toBe(1)
    expect(s.warnings).toBe(1)
    expect(s.upstreamMs).toBe(305)
    expect(s.overheadMs).toBe(35)
    // Carry cost = SUM(this call's total input x turns left after it), in call order:
    // (100+40+15)x2 + (100+60+25)x1 + 100x0.
    expect(s.carryCostTokens).toBe(495)
  })

  it('counts a spend-correction row in the tokens and in NO call count', async () => {
    // A harness CLI costs each turn's input but leaves its output at the message-start snapshot,
    // so the producer files the shortfall as its own row rather than growing a measured turn by
    // tokens it did not produce. The row is real spend and is not a call. Counting it as one
    // reported a phantom call per dispatch on every subscription-harness step (a 4-turn architect
    // read as 5), and no reader could correct for it: a null `turnIndex` is equally the shape of a
    // genuine inline call, which is why the fact is persisted rather than inferred.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({ id: `${ws}-turn`, workspaceId: ws, executionId: e1, completionTokens: 12 }),
    )
    await repo.record(
      metric({
        id: `${ws}-short`,
        workspaceId: ws,
        executionId: e1,
        completionTokens: 900,
        spendOnly: true,
      }),
    )

    const s = (await repo.summarizeByExecution(ws, e1))[0]!
    expect(s.calls).toBe(1)
    expect(s.completionTokens).toBe(912)
  })

  it('reads the spend-only flag back on the stored row, both ways', async () => {
    // Absent on the type and 0 in both schemas, so a producer with no shortfall concept keeps
    // filing calls. The flag has to survive the round trip or the rollup above is deciding on a
    // default rather than on what the producer said.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(metric({ id: `${ws}-plain`, workspaceId: ws, executionId: e1 }))
    await repo.record(
      metric({ id: `${ws}-short`, workspaceId: ws, executionId: e1, spendOnly: true }),
    )

    const byId = new Map((await repo.listByExecution(ws, e1)).map((c) => [c.id, c]))
    expect(byId.get(`${ws}-short`)?.spendOnly).toBe(true)
    expect(byId.get(`${ws}-plain`)?.spendOnly).toBe(false)
  })

  it('groups summaries by agent kind', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({ id: `${ws}-x`, workspaceId: ws, executionId: e1, agentKind: 'coder' }),
    )
    await repo.record(
      metric({ id: `${ws}-y`, workspaceId: ws, executionId: e1, agentKind: 'reviewer' }),
    )
    const summaries = await repo.summarizeByExecution(ws, e1)
    expect(summaries.map((s) => s.agentKind).sort()).toEqual(['coder', 'reviewer'])
  })

  it('splits the rollup by MODEL so a mixed-model step can be priced', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // One agent kind, one phase, two models — the NORMAL shape on a subscription harness,
    // whose CLI serves some of its own turns with a cheaper model of its choosing. The store
    // must keep them apart: cost is a function of `(model, token classes)`, so a cell that
    // lumped both could only be priced at one of their rates and would be wrong either way.
    for (const [id, model, promptTokens] of [
      ['a', 'claude-opus-5', 100],
      ['b', 'claude-opus-5', 200],
      ['c', 'claude-haiku-4-5', 700],
    ] as const) {
      await repo.record(
        metric({
          id: `${ws}-${id}`,
          workspaceId: ws,
          executionId: e1,
          agentKind: 'coder',
          phase: 'agent',
          provider: 'anthropic',
          model,
          promptTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      )
    }
    const cells = (await repo.summarizeByExecution(ws, e1)).sort((a, b) =>
      a.model.localeCompare(b.model),
    )
    expect(cells.map((c) => [c.model, c.calls, c.promptTokens])).toEqual([
      ['claude-haiku-4-5', 1, 700],
      ['claude-opus-5', 2, 300],
    ])
    // Every cell carries its provider too, since a bare model id does not identify a price.
    expect(cells.every((c) => c.provider === 'anthropic')).toBe(true)
    // The store NEVER prices: a price table is deployment configuration, not SQL, so an
    // unpriced cell says null rather than claiming the calls were free.
    expect(cells.every((c) => c.costEstimate === null)).toBe(true)
    // Folding the model away reproduces the single `(agentKind, phase)` cell every consumer
    // reads, with the totals intact.
    const folded = foldRollupsByPhase(cells)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.calls).toBe(3)
    expect(folded[0]?.promptTokens).toBe(1000)
  })

  it('cuts the rollup by phase and charges carry cost per conversation, not per run', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // A coder conversation of three turns spanning two phases, plus a separate reviewer
    // conversation whose calls carry no phase at all.
    const call = (
      id: string,
      createdAt: number,
      phase: string,
      promptTokens: number,
      agentKind = 'coder',
    ) =>
      repo.record(
        metric({
          id: `${ws}-${id}`,
          workspaceId: ws,
          executionId: e1,
          agentKind,
          createdAt,
          phase,
          promptTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      )
    await call('1', 10, 'agent', 100)
    await call('2', 20, 'agent', 200)
    await call('3', 30, 'validation-repair', 50)
    await call('4', 40, '', 400, 'reviewer')
    await call('5', 50, '', 10, 'reviewer')

    const cells = (await repo.summarizeByExecution(ws, e1)).sort((a, b) =>
      `${a.agentKind}/${a.phase}`.localeCompare(`${b.agentKind}/${b.phase}`),
    )
    expect(cells.map((c) => [c.agentKind, c.phase, c.calls])).toEqual([
      // The un-phased slice is a REAL cell of the breakdown, never dropped: a run metered
      // by a channel with no phase concept must not read as a run that spent nothing.
      ['coder', 'agent', 2],
      ['coder', 'validation-repair', 1],
      ['reviewer', '', 2],
    ])
    // Carry cost partitions by CONVERSATION (the delta chain's `(execution, agentKind)` key),
    // not by run: the coder's first turn is re-sent by the two coder turns after it, never by
    // the reviewer's. Run-wide accounting would charge `agent` 100x4 + 200x3 = 1000 instead.
    expect(cells.map((c) => c.carryCostTokens)).toEqual([400, 0, 400])
  })
}

/**
 * The non-proxy producers — a subscription harness's per-call telemetry and an inline call
 * through the `InlineLlmCallRecorder` port — plus the phase/turn axes and re-record idempotency.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMetricProducerTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it("records a subscription harness's per-call telemetry through the observability sink", async () => {
    // The proxy-bypassing path: Claude Code / Codex report per-call metrics off their CLI
    // stream, which the executor feeds through the SAME LlmObservabilityService the proxy
    // uses. This asserts that path lands correctly on each runtime's real store (bodies,
    // vendor, zero timing, and the delta chain), not just the raw repo round-trip above.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    let n = 0
    const record = makeHarnessCallRecorder(
      new LlmObservabilityService({
        llmCallMetricRepository: repo,
        idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
        clock: { now: () => 1 },
      }),
    )
    const call = (overrides: Partial<HarnessCallMetric>): HarnessCallMetric => ({
      model: 'claude-opus-4-8',
      promptText: '[]',
      messageCount: 1,
      responseText: '',
      reasoningText: '',
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      finishReason: 'end_turn',
      ...overrides,
    })
    await record({
      workspaceId: ws,
      executionId: e1,
      agentKind: 'coder',
      provider: 'claude',
      model: 'claude:claude-opus-4-8',
      calls: [
        call({
          promptText: '[{"role":"system","content":"s"},{"role":"user","content":"u"}]',
          messageCount: 2,
          responseText: 'hi',
          inputTokens: 120,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          outputTokens: 30,
        }),
        call({
          promptText:
            '[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"assistant","content":"hi"}]',
          messageCount: 3,
          responseText: 'done',
          inputTokens: 200,
          outputTokens: 40,
        }),
      ],
    })

    const rows = await repo.listByExecution(ws, e1)
    expect(rows).toHaveLength(2)
    const byResp = Object.fromEntries(rows.map((c) => [c.responseText, c]))
    const first = byResp['hi']!
    expect(first.provider).toBe('claude')
    expect(first.model).toBe('claude-opus-4-8') // the call's own model wins
    // The harness's three input classes map across one-for-one; `promptTokens` is the FRESH
    // count, so the row's total input is prompt + read + write.
    expect(first.promptTokens).toBe(120)
    expect(first.cacheReadTokens).toBe(20)
    expect(first.cacheWriteTokens).toBe(10)
    expect(first.totalTokens).toBe(180)
    expect(first.completionTokens).toBe(30)
    // The CLIs expose no per-HTTP timing, so the split is zero.
    expect(first.totalMs).toBe(0)
    expect(first.upstreamMs).toBe(0)
    // The second call chained onto the first as a prompt delta on the real store.
    expect(byResp['done']!.promptPrefixCount).toBe(2)
  })

  it("records an inline (non-proxied) call's telemetry through the observability sink", async () => {
    // The third producer into this store, after the proxy and the subscription harness: an
    // INLINE agent kind / judge / consensus round calling the AI SDK directly. It reaches
    // `llm_call_metrics` only through `makeInlineCallRecorder`, so this asserts the mapping
    // lands on each runtime's real store — in particular the three "an inline call does not
    // have this" answers, each of which a store could plausibly flatten: a null `turnIndex`
    // (no job-scoped counter), a null `httpStatus` (the SDK owns the transport), and the
    // unattributed `''` phase (phases are boundaries the container harness owns).
    const repo = makeRepo()
    const { ws, e1 } = ids()
    let n = 0
    const record = makeInlineCallRecorder(
      new LlmObservabilityService({
        llmCallMetricRepository: repo,
        idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
        clock: { now: () => 1 },
      }),
    )
    const call = (overrides: Partial<InlineLlmCall>): InlineLlmCall => ({
      workspaceId: ws,
      executionId: e1,
      agentKind: 'doc-researcher',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      messageCount: 2,
      toolCount: 0,
      requestMaxTokens: 4096,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      finishReason: 'stop',
      durationMs: 0,
      ok: true,
      errorMessage: null,
      // Bodies are THUNKS: the recorder resolves one only once its gate says it will be
      // stored, so a prompts-off deployment never serialises a prompt it then drops.
      promptText: () => '[]',
      responseText: () => '',
      reasoningText: () => '',
      ...overrides,
    })
    await record(
      call({
        promptText: () => '[{"role":"system","content":"s"},{"role":"user","content":"u"}]',
        responseText: () => 'brief',
        promptTokens: 300,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        completionTokens: 60,
        totalTokens: 410,
        durationMs: 1200,
      }),
    )
    await record(
      call({
        promptText: () =>
          '[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"assistant","content":"brief"}]',
        messageCount: 3,
        responseText: () => 'outline',
        agentKind: 'doc-researcher',
        promptTokens: 400,
        completionTokens: 20,
        totalTokens: 420,
        durationMs: 900,
      }),
    )

    const rows = await repo.listByExecution(ws, e1)
    expect(rows).toHaveLength(2)
    const byResp = Object.fromEntries(rows.map((c) => [c.responseText, c]))
    const first = byResp['brief']!
    expect(first.agentKind).toBe('doc-researcher')
    expect(first.provider).toBe('anthropic')
    expect(first.streaming).toBe(false)
    expect(first.promptTokens).toBe(300)
    expect(first.cacheReadTokens).toBe(40)
    expect(first.cacheWriteTokens).toBe(10)
    expect(first.completionTokens).toBe(60)
    expect(first.requestMaxTokens).toBe(4096)
    // One duration, reported as the whole of it, so the derived overhead is 0 rather than a
    // fabricated transport split the inline path never measured.
    expect(first.totalMs).toBe(1200)
    expect(first.upstreamMs).toBe(1200)
    expect(first.overheadMs).toBe(0)
    // The three "not applicable" answers must survive the round trip un-flattened.
    expect(first.turnIndex).toBeNull()
    expect(first.httpStatus).toBeNull()
    expect(first.phase).toBe('')
    // Consecutive calls of one inline conversation chain as a prompt delta like any other.
    expect(byResp['outline']!.promptPrefixCount).toBe(2)
    // And the rollup sees them, which is what puts an inline step's spend on the board.
    const summary = await repo.summarizeByExecution(ws, e1)
    const cell = summary.find((s) => s.agentKind === 'doc-researcher' && s.phase === '')
    expect(cell?.calls).toBe(2)
    expect(cell?.completionTokens).toBe(80)
  })

  registerMetricPhaseAxisTests(makeRepo, ids)
}

/**
 * The remote-debugging reads: keyset paging in both directions, body sizing/windowing without
 * returning bodies, SQL-side filtering and case-insensitive body search.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMetricDebugReadTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it('pages calls newest-first with a composite keyset cursor', async () => {
    const repo = makeRepo()
    const { ws, e1, e2 } = ids()
    // Two of the three share a millisecond — the case a `created_at`-only cursor loses.
    await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
    await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20 }))
    await repo.record(metric({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))
    await repo.record(metric({ id: `${ws}-x`, workspaceId: ws, executionId: e2, createdAt: 30 }))

    const first = await repo.listPage(ws, { executionId: e1, limit: 2, bodyChars: 0 })
    expect(first.map((c) => c.id)).toEqual([`${ws}-c`, `${ws}-b`])
    const last = first[first.length - 1]!
    const second = await repo.listPage(ws, {
      executionId: e1,
      limit: 2,
      bodyChars: 0,
      cursor: { createdAt: last.createdAt, id: last.id },
    })
    // The tied row is neither repeated nor skipped, and the other run never leaks in.
    expect(second.map((c) => c.id)).toEqual([`${ws}-a`])
  })

  it('walks a conversation forwards when asked for oldest-first order', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
    // The last two share a millisecond, so the ASCENDING composite tie-break is exercised too
    // (the newest-first test covers the descending one).
    await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20 }))
    await repo.record(metric({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))

    const page = await repo.listPage(ws, {
      executionId: e1,
      limit: 2,
      bodyChars: 0,
      order: 'oldest',
    })
    expect(page.map((c) => c.id)).toEqual([`${ws}-a`, `${ws}-b`])
    const last = page[page.length - 1]!
    const next = await repo.listPage(ws, {
      executionId: e1,
      limit: 2,
      bodyChars: 0,
      order: 'oldest',
      cursor: { createdAt: last.createdAt, id: last.id },
    })
    // The ascending cursor must compare the other way round on BOTH keyset legs: a shared `<`
    // would return nothing, and a `<` on the id leg alone would drop the tied row.
    expect(next.map((c) => c.id)).toEqual([`${ws}-c`])
  })

  it('reports body sizes without returning bodies, and slices to the budget when asked', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({
        id: `${ws}-a`,
        workspaceId: ws,
        executionId: e1,
        promptText: '0123456789',
        responseText: 'abcdefghij',
        reasoningText: 'thinking',
      }),
    )

    const [sizesOnly] = await repo.listPage(ws, { executionId: e1, limit: 10, bodyChars: 0 })
    // No body bytes, but the full lengths — which is what makes a zero-cost sweep useful.
    expect(sizesOnly!.prompt).toEqual({ text: '', totalChars: 10 })
    expect(sizesOnly!.response).toEqual({ text: '', totalChars: 10 })
    expect(sizesOnly!.reasoning.totalChars).toBe(8)

    const [preview] = await repo.listPage(ws, { executionId: e1, limit: 10, bodyChars: 4 })
    // LEADING 4 characters: `substr(col, 1, n)` is 1-based, so an off-by-one here would
    // silently drop the first character of every prompt on one runtime only.
    expect(preview!.prompt).toEqual({ text: '0123', totalChars: 10 })
    expect(preview!.response).toEqual({ text: 'abcd', totalChars: 10 })
    // A budget larger than the body returns the body, never padding.
    const [whole] = await repo.listPage(ws, { executionId: e1, limit: 10, bodyChars: 1_000 })
    expect(whole!.reasoning).toEqual({ text: 'thinking', totalChars: 8 })
  })

  it('carries the phase and turn axes onto a page row and a point read', async () => {
    // A page projects its own column list rather than reusing the export mapper, so a column
    // added to `LlmCallMetric` reaches the page only if BOTH repos' page selects gain it. The
    // failure mode is silent on the wire — a debugging caller sees every call unattributed —
    // so the axes are pinned on the page shape, not just on `list`/`export`.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({
        id: `${ws}-a`,
        workspaceId: ws,
        executionId: e1,
        phase: 'validation-repair',
        turnIndex: 7,
      }),
    )
    // The unattributed slice and a turn-less channel: both are REAL values, never dropped rows.
    await repo.record(
      metric({
        id: `${ws}-b`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 2,
        phase: '',
        turnIndex: null,
      }),
    )

    const rows = await repo.listPage(ws, { executionId: e1, limit: 10, bodyChars: 0 })
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(`${ws}-a`)!.phase).toBe('validation-repair')
    expect(byId.get(`${ws}-a`)!.turnIndex).toBe(7)
    expect(byId.get(`${ws}-b`)!.phase).toBe('')
    expect(byId.get(`${ws}-b`)!.turnIndex).toBeNull()

    const point = await repo.get(ws, `${ws}-a`)
    expect(point!.phase).toBe('validation-repair')
    expect(point!.turnIndex).toBe(7)

    // Narrowing by phase happens in SQL, so a caller asking what the repair rounds cost spends
    // its `limit` on those rows instead of paging the run and grouping afterwards.
    const repairs = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      phase: 'validation-repair',
    })
    expect(repairs.map((row) => row.id)).toEqual([`${ws}-a`])
    // '' is a QUERYABLE value, not "no filter" — the unattributed slice is otherwise
    // unreachable, and a truthiness check in any store would silently return the whole run.
    const unattributed = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      phase: '',
    })
    expect(unattributed.map((row) => row.id)).toEqual([`${ws}-b`])
    // An unknown phase is an empty page, never a fallback to everything.
    expect(
      await repo.listPage(ws, { executionId: e1, limit: 10, bodyChars: 0, phase: 'nope' }),
    ).toEqual([])
  })

  it('narrows a page by agent kind and by outcome, in SQL', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(metric({ id: `${ws}-ok`, workspaceId: ws, executionId: e1, createdAt: 10 }))
    await repo.record(
      metric({
        id: `${ws}-warn`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 20,
        finishReason: 'length',
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-err`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 30,
        ok: false,
        httpStatus: 500,
        finishReason: null,
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-other`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 40,
        agentKind: 'tester',
      }),
    )
    // A clean call that recorded NO finish reason at all (a real shape: harness-lifted
    // metrics are read leniently, and not every provider reports one).
    await repo.record(
      metric({
        id: `${ws}-null-ok`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 50,
        finishReason: null,
      }),
    )

    const kind = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      agentKind: 'tester',
    })
    expect(kind.map((c) => c.id)).toEqual([`${ws}-other`])

    const errors = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      outcome: 'error',
    })
    expect(errors.map((c) => c.id)).toEqual([`${ws}-err`])
    const warnings = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      outcome: 'warning',
    })
    expect(warnings.map((c) => c.id)).toEqual([`${ws}-warn`])
    const oks = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      outcome: 'ok',
    })
    // `ok` must admit a NULL finish reason too — a plain `NOT IN (...)` is unknown for NULL in
    // SQL, so a runtime that forgot the null branch would silently drop clean calls.
    expect(oks.map((c) => c.id).sort()).toEqual([`${ws}-ok`, `${ws}-other`, `${ws}-null-ok`].sort())
  })

  it('point-reads one call by id, scoped to its workspace', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, responseText: 'hello world' }),
    )

    const whole = await repo.get(ws, `${ws}-a`)
    expect(whole?.response).toEqual({ text: 'hello world', totalChars: 11 })
    const budgeted = await repo.get(ws, `${ws}-a`, { chars: 5 })
    expect(budgeted?.response).toEqual({ text: 'hello', totalChars: 11 })
    // A foreign workspace reads as missing, never as another tenant's row.
    expect(await repo.get('ws-someone-else', `${ws}-a`)).toBeNull()
    expect(await repo.get(ws, 'llm_nope')).toBeNull()
  })

  it('windows a point read from an offset, so the tail of a large body is reachable', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({
        id: `${ws}-a`,
        workspaceId: ws,
        executionId: e1,
        promptText: '0123456789',
        responseText: 'abcdefghij',
      }),
    )

    // `substr(col, offset + 1, chars)` — 1-based, so an off-by-one here shifts every window
    // by a character on one runtime only.
    const windowed = await repo.get(ws, `${ws}-a`, { chars: 4, offset: 2 })
    expect(windowed?.prompt).toEqual({ text: '2345', totalChars: 10 })
    expect(windowed?.response).toEqual({ text: 'cdef', totalChars: 10 })
    // No budget from an offset: the REST of the body.
    const rest = await repo.get(ws, `${ws}-a`, { offset: 7 })
    expect(rest?.prompt).toEqual({ text: '789', totalChars: 10 })
    // Past the end: empty text, with the real size still reported.
    const past = await repo.get(ws, `${ws}-a`, { chars: 4, offset: 50 })
    expect(past?.prompt).toEqual({ text: '', totalChars: 10 })
    // A zero budget stays a size-only read regardless of the offset.
    const none = await repo.get(ws, `${ws}-a`, { chars: 0, offset: 2 })
    expect(none?.prompt).toEqual({ text: '', totalChars: 10 })
  })

  it('searches bodies case-insensitively in SQL, with literal wildcards and match offsets', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({
        id: `${ws}-tool-err`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 10,
        promptText: '[{"role":"tool","content":"Validation FAILED for tool \\"edit\\""}]',
        responseText: 'let me retry',
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-clean`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 20,
        promptText: '[{"role":"user","content":"all good"}]',
        responseText: 'done',
      }),
    )
    // `100%_done` appears LITERALLY here; the row below would match it only if `%`/`_`
    // behaved as wildcards ("100" + anything + one char + "done").
    await repo.record(
      metric({
        id: `${ws}-literal`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 30,
        responseText: 'progress: 100%_done',
      }),
    )
    await repo.record(
      metric({
        id: `${ws}-wildcard-bait`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 40,
        responseText: 'progress: 100 is done',
      }),
    )

    // Case-insensitive (ASCII), matched against ANY of the three bodies, filtered in SQL.
    const found = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      contains: 'validation failed',
    })
    expect(found.map((c) => c.id)).toEqual([`${ws}-tool-err`])
    // The matched body reports WHERE (0-based code points, feeding a point-read offset
    // directly); the others say null — "searched, not here" — never nothing.
    expect(found[0]!.prompt.matchOffset).toBe('[{"role":"tool","content":"'.length)
    expect(found[0]!.response.matchOffset).toBeNull()

    // A term full of LIKE metacharacters narrows to the literal text on both stores.
    const literal = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      contains: '100%_done',
    })
    expect(literal.map((c) => c.id)).toEqual([`${ws}-literal`])

    // An unsearched page carries NO match offsets — "no search ran" must stay
    // distinguishable from "searched, no match".
    const plain = await repo.listPage(ws, { executionId: e1, limit: 1, bodyChars: 0 })
    expect(plain[0]!.prompt.matchOffset).toBeUndefined()

    // Search composes with the other SQL narrowings (the limit is spent on matches only).
    const composed = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      contains: 'done',
      outcome: 'ok',
    })
    expect(composed.map((c) => c.id).sort()).toEqual(
      [`${ws}-clean`, `${ws}-literal`, `${ws}-wildcard-bait`].sort(),
    )
  })

  it('counts match offsets in code points, matching the slicing unit', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // Two astral-plane emoji ahead of the match: 2 code points, 4 UTF-16 units. `instr`
    // (SQLite) and `position` (Postgres) both count characters, so the reported offset must
    // feed `substr` — and the wire's code-point windows — without unit conversion.
    await repo.record(
      metric({
        id: `${ws}-emoji`,
        workspaceId: ws,
        executionId: e1,
        responseText: '😀😀error here',
      }),
    )
    const found = await repo.listPage(ws, {
      executionId: e1,
      limit: 10,
      bodyChars: 0,
      contains: 'error',
    })
    expect(found[0]!.response.matchOffset).toBe(2)
  })
}

/**
 * Batch append (ignoring ids already stored) and retention pruning.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMetricBatchTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it('batch-appends calls, ignoring ids it already stored', async () => {
    // The mothership-mode telemetry ingest (docs/initiatives/mothership-mode.md, PR 5) uploads a
    // finished run's calls through `recordMany` and RETRIES a chunk whose ack was lost, so both
    // halves matter: the batch lands whole, and re-offering it is inert. Ignoring rather than
    // overwriting is what protects the stored prompt DELTA, which is only meaningful against the
    // chain tip that preceded the row's FIRST write.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.recordMany([
      metric({ id: `${ws}-1`, workspaceId: ws, executionId: e1, createdAt: 10 }),
      metric({ id: `${ws}-2`, workspaceId: ws, executionId: e1, createdAt: 20 }),
    ])
    expect((await repo.listByExecution(ws, e1)).map((c) => c.id)).toEqual([`${ws}-2`, `${ws}-1`])

    await repo.recordMany([
      metric({
        id: `${ws}-1`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 10,
        responseText: 'rewritten',
      }),
      metric({ id: `${ws}-3`, workspaceId: ws, executionId: e1, createdAt: 30 }),
    ])
    const after = await repo.listByExecution(ws, e1)
    expect(after.map((c) => c.id)).toEqual([`${ws}-3`, `${ws}-2`, `${ws}-1`])
    expect(after.find((c) => c.id === `${ws}-1`)?.responseText).toBe('ok')

    // An empty batch is a no-op, never an error — the drain posts until a page comes back empty.
    await expect(repo.recordMany([])).resolves.toBeUndefined()
  })

  it('prunes rows older than a cutoff', async () => {
    const repo = makeRepo()
    const { ws, e1 } = ids()
    // Far-apart timestamps so the cutoff is unambiguous. `deleteOlderThan` is a
    // global (table-wide) retention prune, so its count can include other cases'
    // rows in the shared DB — assert the scoped, deterministic outcome instead.
    await repo.record(
      metric({ id: `${ws}-old`, workspaceId: ws, executionId: e1, createdAt: 1_000 }),
    )
    await repo.record(
      metric({ id: `${ws}-new`, workspaceId: ws, executionId: e1, createdAt: 9_000_000 }),
    )
    const removed = await repo.deleteOlderThan(2_000)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect((await repo.listByExecution(ws, e1)).map((c) => c.id)).toEqual([`${ws}-new`])
  })
}

/**
 * The phase and turn axes (including the unattributed slice), the harness phase stamped at
 * emit time, re-record idempotency, and the promptless subagent call kept out of the chain.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMetricPhaseAxisTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it('round-trips the phase and turn axes, including the unattributed slice', async () => {
    // The token-burn instrument's two columns (docs/initiatives/token-burn-instrumentation.md).
    // They exist to tell a repair round's spend apart from the agent's own loop, so what a
    // store must not do is flatten either one — an integer column that drops NULL to 0 would
    // sort every proxied call to the front of its phase as "turn 0".
    const repo = makeRepo()
    const { ws, e1 } = ids()
    await repo.record(
      metric({
        id: `${ws}-p1`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 10,
        phase: 'validation-repair',
        turnIndex: 7,
      }),
    )
    // A proxied call: a real row with a real phase, but no job-scoped turn counter behind it.
    await repo.record(
      metric({
        id: `${ws}-p2`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 20,
        turnIndex: null,
      }),
    )
    // Nothing could attribute this one — the unattributed slice is a REAL group, not a gap.
    await repo.record(
      metric({
        id: `${ws}-p3`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 30,
        phase: '',
        turnIndex: null,
      }),
    )
    const rows = Object.fromEntries((await repo.listByExecution(ws, e1)).map((r) => [r.id, r]))
    expect(rows[`${ws}-p1`]!.phase).toBe('validation-repair')
    expect(rows[`${ws}-p1`]!.turnIndex).toBe(7)
    expect(rows[`${ws}-p2`]!.turnIndex).toBeNull()
    expect(rows[`${ws}-p3`]!.phase).toBe('')
    expect(rows[`${ws}-p3`]!.turnIndex).toBeNull()
  })

  it('carries the harness phase onto the row and the turn index off `seq`', async () => {
    // The producing path for those columns: the harness stamps the phase it is IN when the
    // call is emitted, and its job-scoped `seq` doubles as the turn ordinal — the same number
    // the row id is minted from, so the two can never disagree. An older image that reports no
    // phase must land in the unattributed slice rather than be guessed at from the agent kind.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    let n = 0
    const record = makeHarnessCallRecorder(
      new LlmObservabilityService({
        llmCallMetricRepository: repo,
        idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
        clock: { now: () => 1 },
      }),
    )
    const call = (seq: number, phase?: string): HarnessCallMetric => ({
      model: 'claude-opus-4-8',
      promptText: JSON.stringify(Array.from({ length: seq + 1 }, () => ({ role: 'user' }))),
      messageCount: seq + 1,
      responseText: `r${seq}`,
      reasoningText: '',
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      finishReason: 'end_turn',
      seq,
      ...(phase !== undefined ? { phase } : {}),
    })
    await record({
      workspaceId: ws,
      executionId: e1,
      agentKind: 'coder',
      provider: 'claude',
      model: 'claude:claude-opus-4-8',
      jobId: `${ws}-job`,
      calls: [call(0, 'agent'), call(1, 'validation-repair'), call(2)],
    })

    const rows = Object.fromEntries((await repo.listByExecution(ws, e1)).map((r) => [r.id, r]))
    expect(rows[`${ws}-job-hc-0`]!.phase).toBe('agent')
    expect(rows[`${ws}-job-hc-0`]!.turnIndex).toBe(0)
    expect(rows[`${ws}-job-hc-1`]!.phase).toBe('validation-repair')
    expect(rows[`${ws}-job-hc-1`]!.turnIndex).toBe(1)
    expect(rows[`${ws}-job-hc-2`]!.phase).toBe('')
    expect(rows[`${ws}-job-hc-2`]!.turnIndex).toBe(2)
  })

  it('ignores a re-recorded call instead of duplicating or overwriting its row', async () => {
    // A harness call reaches the backend more than once BY DESIGN: live as the harness
    // drains it mid-run, again in the job's terminal list, and again on a durable-driver
    // replay. Each mints the same `<jobId>-hc-<seq>` id, so the store must ignore the
    // repeat. Two ways this goes wrong on a real store, neither visible to a unit test: a
    // plain INSERT throws (dropping every LATER call in the same batch), and an UPSERT
    // rewrites the row's prompt delta against a chain tip that has since moved on.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    let n = 0
    const record = makeHarnessCallRecorder(
      new LlmObservabilityService({
        llmCallMetricRepository: repo,
        idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
        clock: { now: () => 1 },
      }),
    )
    // Each call's prompt extends the previous one, so the delta chain has something to
    // compress and a rewritten row would show it. `seq` is the harness's job-scoped sequence:
    // it — NOT the position in the batch — is what makes the two channels agree on a row id.
    const call = (seq: number, responseText: string): HarnessCallMetric => ({
      model: 'claude-opus-4-8',
      promptText: JSON.stringify(
        Array.from({ length: seq + 1 }, () => ({ role: 'user', content: 'u' })),
      ),
      messageCount: seq + 1,
      responseText,
      reasoningText: '',
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      finishReason: 'end_turn',
      seq,
    })
    const base = {
      workspaceId: ws,
      executionId: e1,
      agentKind: 'coder',
      provider: 'claude',
      model: 'claude:claude-opus-4-8',
      jobId: `${ws}-job`,
    }
    // The live drain records calls 0 and 1 as they happen...
    await record({ ...base, calls: [call(0, 'first'), call(1, 'second')] })
    // ...then the terminal write re-offers them ALONGSIDE the ones that never streamed —
    // deliberately NOT in `seq` order, so a recorder that fell back to the batch index would
    // mint `-hc-0` for 'third' and see it swallowed as a duplicate of 'first'.
    await record({
      ...base,
      calls: [call(2, 'third'), call(0, 'first'), call(3, 'fourth'), call(1, 'second')],
    })

    const rows = await repo.listByExecution(ws, e1)
    // Four calls, four rows: the repeats were ignored AND the new ones still landed — a
    // throwing INSERT would have aborted the batch and lost 'third' and 'fourth'.
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.responseText).sort()).toEqual(['first', 'fourth', 'second', 'third'])
    // First write wins: the chain each row was stored against is intact, not recomputed
    // against a later tip, and the newly-landed calls chained onto it in order.
    const byResponse = Object.fromEntries(rows.map((r) => [r.responseText, r]))
    expect(byResponse['first']!.promptPrefixCount).toBe(0)
    expect(byResponse['second']!.promptPrefixCount).toBe(1)
    expect(byResponse['third']!.promptPrefixCount).toBe(2)
    expect(byResponse['fourth']!.promptPrefixCount).toBe(3)
  })

  it('keeps a promptless subagent call out of the prompt-delta chain', async () => {
    // Subagent calls carry no re-sendable request transcript (empty prompt, messageCount 0),
    // and they interleave with the parent's in RECORD order now that telemetry streams live.
    // If one becomes the chain tip, the next parent call can't chain onto it and stores its
    // whole prompt — so a subagent-heavy run loses the compression this chain exists for. The
    // clock advances per call here, which is what makes the subagent row the newest.
    const repo = makeRepo()
    const { ws, e1 } = ids()
    let n = 0
    let t = 0
    const record = makeHarnessCallRecorder(
      new LlmObservabilityService({
        llmCallMetricRepository: repo,
        idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
        clock: { now: () => (t += 1) },
      }),
    )
    const base = {
      workspaceId: ws,
      executionId: e1,
      agentKind: 'pr-reviewer',
      provider: 'claude',
      model: 'claude:claude-opus-4-8',
    }
    const tokens = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }
    const parent = (messageCount: number, responseText: string): HarnessCallMetric => ({
      model: 'claude-opus-4-8',
      promptText: JSON.stringify(
        Array.from({ length: messageCount }, () => ({ role: 'user', content: 'u' })),
      ),
      messageCount,
      responseText,
      reasoningText: '',
      ...tokens,
      finishReason: 'end_turn',
    })
    const subagent = (responseText: string): HarnessCallMetric => ({
      model: 'claude-opus-4-8',
      promptText: '',
      messageCount: 0,
      responseText,
      reasoningText: '',
      ...tokens,
      finishReason: 'end_turn',
    })

    await record({ ...base, calls: [parent(1, 'p1')] })
    await record({ ...base, calls: [subagent('s1')] })
    await record({ ...base, calls: [parent(2, 'p2')] })

    const rows = await repo.listByExecution(ws, e1)
    const byResponse = Object.fromEntries(rows.map((r) => [r.responseText, r]))
    // The subagent row lands, as its own chain-less entry.
    expect(byResponse['s1']!.promptPrefixCount).toBe(0)
    // The parent call after it still chained onto the previous PARENT call (prefix 1), rather
    // than falling back to storing its whole prompt (prefix 0) — so what it stores is the ONE
    // new message, and the chain it hangs off is the parent's.
    expect(byResponse['p2']!.promptPrefixCount).toBe(1)
    expect(JSON.parse(byResponse['p2']!.promptText)).toHaveLength(1)
  })

  // --- the remote debugging surface's bounded page (`/api/v1/debug/*`) -----------------
  // These are the assertions that keep the size guarantee honest across stores: the slice and
  // every filter are pushed into SQL, so a runtime that implemented either in JavaScript (or
  // sliced with a different offset convention — `substr` is 1-based, `slice` is 0-based) would
  // hand a remote caller more bytes than it budgeted for, and only fail here.
}

/**
 * The mothership-mode READ-THROUGH read: a bounded, keyset-paginated page of one run's calls with
 * the bodies WHOLE (docs/initiatives/mothership-mode.md, PR 5).
 *
 * Its own registrar rather than more of {@link registerMetricDebugReadTests}, and not only for the
 * per-function line budget: it is a different surface with a different contract. The debug reads
 * return SLICES plus their lengths and answer a human paging a run; this returns the stored record
 * so a node can reconstitute exactly what a direct repository call would have given it.
 */
function registerMetricRunPageTests(
  makeRepo: () => LlmCallMetricRepository,
  ids: () => MetricIds,
): void {
  it("pages a run's calls WITH whole bodies on the same composite keyset", async () => {
    // The mothership-mode READ-THROUGH read (docs/initiatives/mothership-mode.md, PR 5): a
    // laptop rendering a run whose local rows were pruned drains this from the mothership.
    // Where `listPage` returns SLICES plus their lengths, this returns the stored record, so
    // the node can answer `listByExecution` with exactly what a direct repo would have.
    const repo = makeRepo()
    const { ws, e1, e2 } = ids()
    await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
    // Two share a millisecond — the tie a `created_at`-only cursor loses.
    await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20 }))
    await repo.record(
      metric({
        id: `${ws}-c`,
        workspaceId: ws,
        executionId: e1,
        createdAt: 20,
        agentKind: 'merger',
      }),
    )
    await repo.record(metric({ id: `${ws}-x`, workspaceId: ws, executionId: e2, createdAt: 30 }))

    const first = await repo.listRunPage(ws, { executionId: e1, limit: 2 })
    expect(first.map((c) => c.id)).toEqual([`${ws}-c`, `${ws}-b`])
    // Whole bodies, not slices — no `totalChars`, no truncation.
    expect(first[0]?.responseText).toBe('ok')
    const last = first[first.length - 1]!
    const second = await repo.listRunPage(ws, {
      executionId: e1,
      limit: 2,
      cursor: { createdAt: last.createdAt, id: last.id },
    })
    expect(second.map((c) => c.id)).toEqual([`${ws}-a`])
    // Drained to exhaustion it reproduces `listByExecution` exactly, which is the property the
    // read-through relies on to answer that method from the mothership.
    expect([...first, ...second].map((c) => c.id)).toEqual(
      (await repo.listByExecution(ws, e1)).map((c) => c.id),
    )
    // The agent-kind narrowing is applied in SQL, so a caller's limit is spent on that kind.
    expect(
      (await repo.listRunPage(ws, { executionId: e1, limit: 10, agentKind: 'merger' })).map(
        (c) => c.id,
      ),
    ).toEqual([`${ws}-c`])
    // An unknown run pages empty rather than throwing.
    expect(await repo.listRunPage(ws, { executionId: 'exec-nothing', limit: 10 })).toEqual([])
  })
}
