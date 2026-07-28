import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  LlmCallMetric,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './telemetryStore.js'

// Unit coverage for the mothership-mode LOCAL telemetry store. It asserts the `node:sqlite`
// repositories behave identically to their D1/Drizzle counterparts against an in-memory db —
// the properties the engine actually depends on, not just "a row went in":
//   - `record` is FIRST-WRITE-WINS on a duplicate id (the harness-call recorder deliberately
//     re-offers the same id live, terminally and on a durable-driver replay), because overwriting
//     would invalidate a stored prompt DELTA;
//   - `latestChainTip` skips `message_count = 0` rows (a subagent call is not a chainable tip);
//   - `summarizeByExecution` aggregates per agent kind, splitting errors from warnings;
//   - the quota-cycle upsert accumulates inside an active window and RESETS past it.

function metric(overrides: Partial<LlmCallMetric> = {}): LlmCallMetric {
  return {
    id: 'call_1',
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'claude',
    createdAt: 1000,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    messageCount: 3,
    toolCount: 2,
    requestMaxTokens: 4096,
    promptTokens: 100,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    completionTokens: 50,
    totalTokens: 165,
    finishReason: 'stop',
    upstreamMs: 900,
    overheadMs: 100,
    totalMs: 1000,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[{"role":"user"}]',
    promptPrefixCount: 0,
    promptHash: 'hash-1',
    responseText: 'done',
    reasoningText: '',
    ...overrides,
  }
}

describe('SqliteLlmCallMetricRepository', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('ignores a repeat of an already-stored id rather than overwriting it', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ promptText: 'first', promptPrefixCount: 0 }))
    // The same deterministic id re-offered with a DIFFERENT delta — what the terminal harness
    // list does after the live poll drain already stored it. Overwriting would leave the row's
    // delta meaningless against the tip that preceded its first write.
    await repo.record(metric({ promptText: 'second', promptPrefixCount: 7 }))
    const rows = await repo.listByExecution('ws_1', 'exec_1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.promptText).toBe('first')
    expect(rows[0]?.promptPrefixCount).toBe(0)
  })

  it('round-trips every field, including the three input-token classes', async () => {
    await store.llmCallMetricRepository.record(metric({ streaming: true, ok: false }))
    const [row] = await store.llmCallMetricRepository.listByExecution('ws_1', 'exec_1')
    expect(row).toEqual(metric({ streaming: true, ok: false }))
  })

  it('lists newest first, honours the limit, and narrows by agent kind in SQL', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'c1', createdAt: 1000, agentKind: 'coder' }))
    await repo.record(metric({ id: 'c2', createdAt: 2000, agentKind: 'tester' }))
    await repo.record(metric({ id: 'c3', createdAt: 3000, agentKind: 'coder' }))

    expect((await repo.listByExecution('ws_1', 'exec_1')).map((m) => m.id)).toEqual([
      'c3',
      'c2',
      'c1',
    ])
    // The limit is spent on the NARROWED kind's newest calls, not on whatever sorts newest
    // overall — the reason the filter is in SQL rather than applied after the read.
    expect((await repo.listByExecution('ws_1', 'exec_1', 1, 'coder')).map((m) => m.id)).toEqual([
      'c3',
    ])
    expect((await repo.listByExecution('ws_1', 'exec_1', 2)).map((m) => m.id)).toEqual(['c3', 'c2'])
  })

  it('returns the newest CHAINABLE tip, skipping subagent calls with no prompt chain', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'c1', createdAt: 1000, messageCount: 4, promptHash: 'h1' }))
    // A subagent call: no re-sendable chain, and it interleaves with the parent's calls now that
    // harness telemetry streams live. Treating it as the tip would make the next parent call
    // unchainable — it would store its whole prompt instead of a delta.
    await repo.record(metric({ id: 'c2', createdAt: 2000, messageCount: 0, promptHash: 'h2' }))

    expect(await repo.latestChainTip('ws_1', 'exec_1', 'coder')).toEqual({
      messageCount: 4,
      promptHash: 'h1',
    })
    expect(await repo.latestChainTip('ws_1', 'exec_1', 'tester')).toBeNull()
  })

  it('aggregates per agent kind, separating failures from truncation warnings', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'c1', completionTokens: 50, requestMaxTokens: 4096 }))
    await repo.record(
      metric({ id: 'c2', completionTokens: 900, finishReason: 'length', requestMaxTokens: 8192 }),
    )
    await repo.record(metric({ id: 'c3', ok: false, finishReason: null, httpStatus: 500 }))
    await repo.record(metric({ id: 'c4', agentKind: 'tester' }))

    const summaries = await repo.summarizeByExecution('ws_1', 'exec_1')
    const coder = summaries.find((s) => s.agentKind === 'coder')
    expect(coder).toMatchObject({
      calls: 3,
      promptTokens: 300,
      cacheReadTokens: 30,
      cacheWriteTokens: 15,
      peakCompletionTokens: 900,
      maxOutputTokens: 8192,
      truncatedCalls: 1,
      errors: 1,
      // `length` on a SUCCESSFUL call is a warning, not an error — the failed call is not
      // double-counted here.
      warnings: 1,
    })
    expect(summaries.find((s) => s.agentKind === 'tester')?.calls).toBe(1)
  })

  it('slices bodies in SQL on a bounded page, and reads no body bytes at a zero budget', async () => {
    // The properties that make the page safe to expose remotely, and that a hand-written SELECT
    // list can silently lose on ONE store: `substr` is 1-based (an off-by-one drops the leading
    // character), and a 0 budget must select a literal '' while still reporting the real length.
    const repo = store.llmCallMetricRepository
    await repo.record(
      metric({
        id: 'c1',
        promptText: '0123456789',
        responseText: 'abcdefghij',
        reasoningText: 'th',
      }),
    )

    const [sizesOnly] = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 0,
    })
    expect(sizesOnly!.prompt).toEqual({ text: '', totalChars: 10 })
    expect(sizesOnly!.response).toEqual({ text: '', totalChars: 10 })
    expect(sizesOnly!.phase).toBe('agent')
    expect(sizesOnly!.turnIndex).toBeNull()

    const [preview] = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 4,
    })
    expect(preview!.prompt).toEqual({ text: '0123', totalChars: 10 })

    // A point read's window is what makes the TAIL of a long body reachable.
    const windowed = await repo.get('ws_1', 'c1', { chars: 3, offset: 6 })
    expect(windowed!.prompt).toEqual({ text: '678', totalChars: 10 })
    // An omitted budget returns the whole body rather than an empty string.
    expect((await repo.get('ws_1', 'c1'))!.response.text).toBe('abcdefghij')
    // Workspace-scoped, so a foreign id reads as missing rather than leaking.
    expect(await repo.get('ws_other', 'c1')).toBeNull()
  })

  it('searches bodies in SQL, reporting a literal match offset, and narrows by outcome', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'c_hit', responseText: 'xxxNeedleYYY' }))
    await repo.record(metric({ id: 'c_miss', createdAt: 900, responseText: 'nothing here' }))
    await repo.record(metric({ id: 'c_pct', createdAt: 800, responseText: 'a%b' }))
    await repo.record(metric({ id: 'c_err', createdAt: 700, ok: false }))
    await repo.record(metric({ id: 'c_warn', createdAt: 600, finishReason: 'length' }))

    // ASCII-case-insensitive, and the offset is where a point read should start.
    const found = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 0,
      contains: 'needle',
    })
    expect(found.map((r) => r.id)).toEqual(['c_hit'])
    expect(found[0]!.response.matchOffset).toBe(3)
    expect(found[0]!.prompt.matchOffset).toBeNull()

    // `%` is a LITERAL, not a wildcard — the shared escaper plus SQLite's mandatory ESCAPE clause.
    expect(
      (
        await repo.listPage('ws_1', {
          executionId: 'exec_1',
          limit: 10,
          bodyChars: 0,
          contains: 'a%b',
        })
      ).map((r) => r.id),
    ).toEqual(['c_pct'])

    const errors = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 0,
      outcome: 'error',
    })
    expect(errors.map((r) => r.id)).toEqual(['c_err'])
    const warnings = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 0,
      outcome: 'warning',
    })
    expect(warnings.map((r) => r.id)).toEqual(['c_warn'])
    // `ok` must admit a NULL finish reason, or a plain successful call vanishes from the filter.
    await repo.record(metric({ id: 'c_null', createdAt: 500, finishReason: null }))
    const oks = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 10,
      bodyChars: 0,
      outcome: 'ok',
    })
    expect(oks.map((r) => r.id)).toContain('c_null')
    expect(oks.map((r) => r.id)).not.toContain('c_err')
  })

  it('walks a page by composite keyset in both directions', async () => {
    const repo = store.llmCallMetricRepository
    // A same-millisecond burst: the tie is the whole reason the keyset carries `id`.
    await repo.record(metric({ id: 'c_a', createdAt: 1000 }))
    await repo.record(metric({ id: 'c_b', createdAt: 1000 }))
    await repo.record(metric({ id: 'c_c', createdAt: 2000 }))

    const first = await repo.listPage('ws_1', { executionId: 'exec_1', limit: 2, bodyChars: 0 })
    expect(first.map((r) => r.id)).toEqual(['c_c', 'c_b'])
    const next = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 2,
      bodyChars: 0,
      cursor: { createdAt: first[1]!.createdAt, id: first[1]!.id },
    })
    expect(next.map((r) => r.id)).toEqual(['c_a'])

    // `oldest` walks forwards, which is how a caller reads deltas back into a transcript.
    const oldest = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 3,
      bodyChars: 0,
      order: 'oldest',
    })
    expect(oldest.map((r) => r.id)).toEqual(['c_a', 'c_b', 'c_c'])
  })

  it('prunes by age and reports how many rows it reclaimed', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'old', createdAt: 500 }))
    await repo.record(metric({ id: 'new', createdAt: 5000 }))
    expect(await repo.deleteOlderThan(1000)).toBe(1)
    expect((await repo.listByExecution('ws_1', 'exec_1')).map((m) => m.id)).toEqual(['new'])
  })
})

function snapshot(overrides: Partial<AgentContextSnapshot> = {}): AgentContextSnapshot {
  return {
    id: 'snap_1',
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'coder',
    stepIndex: 2,
    createdAt: 1000,
    model: 'claude',
    harness: 'pi',
    systemPrompt: 'system',
    userPrompt: 'user',
    fragments: [{ id: 'frag_1', body: 'body' }],
    contextFiles: [
      {
        path: '.cat-context/task.md',
        title: 'Task',
        url: 'https://tracker.test/1',
        content: 'task',
      },
    ],
    extras: { pipelineId: 'pl_quick' },
    ...overrides,
  }
}

describe('SqliteAgentContextSnapshotRepository', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('round-trips the JSON-shaped fragment / file / extras columns', async () => {
    await store.agentContextSnapshotRepository.record(snapshot())
    const [row] = await store.agentContextSnapshotRepository.listByExecution('ws_1', 'exec_1')
    expect(row).toEqual(snapshot())
  })

  it('lists newest first and prunes by age', async () => {
    const repo = store.agentContextSnapshotRepository
    await repo.record(snapshot({ id: 's1', createdAt: 1000 }))
    await repo.record(snapshot({ id: 's2', createdAt: 2000 }))
    expect((await repo.listByExecution('ws_1', 'exec_1')).map((s) => s.id)).toEqual(['s2', 's1'])
    expect(await repo.deleteOlderThan(1500)).toBe(1)
    expect((await repo.listByExecution('ws_1', 'exec_1')).map((s) => s.id)).toEqual(['s2'])
  })

  it('indexes by SIZE without selecting a body, and point-reads the whole snapshot', async () => {
    const repo = store.agentContextSnapshotRepository
    await repo.record(snapshot({ id: 's1', createdAt: 1000, systemPrompt: 'sys', userPrompt: 'u' }))
    await repo.record(snapshot({ id: 's2', createdAt: 2000, stepIndex: 3 }))

    const index = await repo.listIndex('ws_1', { executionId: 'exec_1', limit: 10 })
    expect(index.map((r) => r.id)).toEqual(['s2', 's1'])
    // Sizes are SQL `length()`s of the body-bearing columns, never the bodies themselves.
    const s1 = index.find((r) => r.id === 's1')!
    expect(s1.systemPromptChars).toBe(3)
    expect(s1.userPromptChars).toBe(1)
    expect(s1.fragmentsChars).toBeGreaterThan(0)
    expect(s1).not.toHaveProperty('systemPrompt')

    expect(
      (await repo.listIndex('ws_1', { executionId: 'exec_1', limit: 10, stepIndex: 3 })).map(
        (r) => r.id,
      ),
    ).toEqual(['s2'])
    expect(
      (
        await repo.listIndex('ws_1', {
          executionId: 'exec_1',
          limit: 10,
          cursor: { createdAt: 2000, id: 's2' },
        })
      ).map((r) => r.id),
    ).toEqual(['s1'])

    // The point read carries the bodies; the count is one indexed COUNT over the run.
    expect((await repo.get('ws_1', 's1'))!.systemPrompt).toBe('sys')
    expect(await repo.get('ws_other', 's1')).toBeNull()
    expect(await repo.countByExecution('ws_1', 'exec_1')).toBe(2)
    expect(await repo.countByExecution('ws_1', 'exec_absent')).toBe(0)
  })
})

function search(overrides: Partial<AgentSearchQuery> = {}): AgentSearchQuery {
  return {
    id: 'q_1',
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'researcher',
    provider: 'brave',
    query: 'how to vitest',
    resultCount: 7,
    createdAt: 1000,
    ...overrides,
  }
}

describe('SqliteAgentSearchQueryRepository', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('round-trips a query and keeps a null provider null', async () => {
    await store.agentSearchQueryRepository.record(search())
    await store.agentSearchQueryRepository.record(search({ id: 'q_2', provider: null }))
    const rows = await store.agentSearchQueryRepository.listByExecution('ws_1', 'exec_1')
    expect(rows.map((q) => q.provider)).toEqual([null, 'brave'])
  })

  it('prunes by age', async () => {
    const repo = store.agentSearchQueryRepository
    await repo.record(search({ id: 'q_old', createdAt: 100 }))
    await repo.record(search({ id: 'q_new', createdAt: 9000 }))
    expect(await repo.deleteOlderThan(1000)).toBe(1)
    expect((await repo.listByExecution('ws_1', 'exec_1')).map((q) => q.id)).toEqual(['q_new'])
  })

  it('bounds a page by row count on a composite keyset, and counts a run', async () => {
    const repo = store.agentSearchQueryRepository
    // Same-millisecond rows again: these carry no unbounded body, so the bound is on ROW COUNT.
    await repo.record(search({ id: 'q_a', createdAt: 1000 }))
    await repo.record(search({ id: 'q_b', createdAt: 1000 }))
    await repo.record(search({ id: 'q_c', createdAt: 2000 }))

    const first = await repo.listPage('ws_1', { executionId: 'exec_1', limit: 2 })
    expect(first.map((q) => q.id)).toEqual(['q_c', 'q_b'])
    const next = await repo.listPage('ws_1', {
      executionId: 'exec_1',
      limit: 2,
      cursor: { createdAt: first[1]!.createdAt, id: first[1]!.id },
    })
    expect(next.map((q) => q.id)).toEqual(['q_a'])

    expect(await repo.countByExecution('ws_1', 'exec_1')).toBe(3)
    expect(await repo.countByExecution('ws_other', 'exec_1')).toBe(0)
  })
})

function logRecord(overrides: Partial<ProvisioningLogRecord> = {}): ProvisioningLogRecord {
  return {
    id: 'plog_1',
    workspaceId: 'ws_1',
    subsystem: 'container',
    operation: 'dispatch',
    targetId: 'job_1',
    providerId: null,
    blockId: 'blk_1',
    executionId: 'exec_1',
    outcome: 'success',
    error: null,
    detail: null,
    createdAt: 1000,
    ...overrides,
  }
}

describe('SqliteProvisioningLogRepository', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('filters by subsystem, execution, target and keyset, newest first', async () => {
    const repo = store.provisioningLogRepository
    await repo.append(logRecord({ id: 'p1', createdAt: 1000 }))
    await repo.append(logRecord({ id: 'p2', createdAt: 2000, subsystem: 'environment' }))
    await repo.append(logRecord({ id: 'p3', createdAt: 3000, executionId: 'exec_2' }))

    expect((await repo.list('ws_1')).map((r) => r.id)).toEqual(['p3', 'p2', 'p1'])
    expect((await repo.list('ws_1', { subsystem: 'environment' })).map((r) => r.id)).toEqual(['p2'])
    expect((await repo.list('ws_1', { executionId: 'exec_1' })).map((r) => r.id)).toEqual([
      'p2',
      'p1',
    ])
    expect((await repo.list('ws_1', { targetId: 'job_1' })).map((r) => r.id)).toHaveLength(3)
    expect(
      (await repo.list('ws_1', { cursor: { createdAt: 2000, id: 'p2' } })).map((r) => r.id),
    ).toEqual(['p1'])
    expect((await repo.list('ws_1', { limit: 1 })).map((r) => r.id)).toEqual(['p3'])
    expect(await repo.list('ws_other')).toEqual([])
  })

  it('pages rows sharing a millisecond, which a bare createdAt bound would drop', async () => {
    // The reason the keyset is composite: provisioning attempts are appended in bursts, so a
    // `created_at`-only bound would skip the tie instead of continuing through it.
    const repo = store.provisioningLogRepository
    await repo.append(logRecord({ id: 'p_a', createdAt: 5000 }))
    await repo.append(logRecord({ id: 'p_b', createdAt: 5000 }))
    await repo.append(logRecord({ id: 'p_c', createdAt: 5000 }))

    const first = await repo.list('ws_1', { limit: 2 })
    expect(first.map((r) => r.id)).toEqual(['p_c', 'p_b'])
    const last = first[first.length - 1]!
    const next = await repo.list('ws_1', {
      limit: 2,
      cursor: { createdAt: last.createdAt, id: last.id },
    })
    expect(next.map((r) => r.id)).toEqual(['p_a'])
  })

  it('counts a run total and its failures in one pass', async () => {
    // The pair travels together (see the port): for a run whose container never came up there is
    // no LLM telemetry at all, so the failure count is the only thing that explains the run.
    const repo = store.provisioningLogRepository
    await repo.append(logRecord({ id: 'ok_1' }))
    await repo.append(logRecord({ id: 'bad_1', outcome: 'failure' }))
    await repo.append(logRecord({ id: 'bad_2', outcome: 'failure' }))
    await repo.append(logRecord({ id: 'other', executionId: 'exec_2' }))

    expect(await repo.countByExecution('ws_1', 'exec_1')).toEqual({ total: 3, failures: 2 })
    // A run with no rows is a real zero, not a missing answer.
    expect(await repo.countByExecution('ws_1', 'exec_absent')).toEqual({ total: 0, failures: 0 })
  })

  it('round-trips the verbatim error + structured detail of a failure', async () => {
    await store.provisioningLogRepository.append(
      logRecord({ outcome: 'failure', error: 'no such image', detail: '{"runtime":"docker"}' }),
    )
    const [row] = await store.provisioningLogRepository.list('ws_1')
    expect(row).toMatchObject({
      outcome: 'failure',
      error: 'no such image',
      detail: '{"runtime":"docker"}',
    })
  })

  it('prunes by age', async () => {
    const repo = store.provisioningLogRepository
    await repo.append(logRecord({ id: 'old', createdAt: 100 }))
    await repo.append(logRecord({ id: 'new', createdAt: 9000 }))
    expect(await repo.deleteOlderThan(1000)).toBe(1)
    expect((await repo.list('ws_1')).map((r) => r.id)).toEqual(['new'])
  })
})

describe('SqliteSubscriptionQuotaCycleRepository', () => {
  let store: LocalTelemetryStore
  const KEY = {
    id: 'cyc_1',
    scope: 'pooled',
    scopeId: 'tok_1',
    vendor: 'claude',
    windowKind: '5h',
  } as const
  const WINDOW = 5 * 60 * 60 * 1000

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('accumulates inside an active window and keeps the original anchor', async () => {
    const repo = store.subscriptionQuotaCycleRepository
    await repo.recordUsage(KEY, { inputTokens: 100, outputTokens: 20 }, 1000, WINDOW)
    await repo.recordUsage(KEY, { inputTokens: 50, outputTokens: 5 }, 2000, WINDOW)

    const [cycle] = await repo.listByScopeVendor('pooled', 'tok_1', 'claude')
    expect(cycle).toMatchObject({
      windowStartedAt: 1000,
      inputTokens: 150,
      outputTokens: 25,
      requestCount: 2,
      updatedAt: 2000,
    })
  })

  it('resets the counters and re-anchors once the window has aged out', async () => {
    const repo = store.subscriptionQuotaCycleRepository
    await repo.recordUsage(KEY, { inputTokens: 100, outputTokens: 20 }, 1000, WINDOW)
    const past = 1000 + WINDOW + 1
    await repo.recordUsage(KEY, { inputTokens: 7, outputTokens: 3 }, past, WINDOW)

    const [cycle] = await repo.listByScopeVendor('pooled', 'tok_1', 'claude')
    expect(cycle).toMatchObject({
      windowStartedAt: past,
      inputTokens: 7,
      outputTokens: 3,
      requestCount: 1,
    })
  })

  it('keeps window kinds and scopes apart, and prunes long-idle cycles', async () => {
    const repo = store.subscriptionQuotaCycleRepository
    await repo.recordUsage(KEY, { inputTokens: 100, outputTokens: 20 }, 1000, WINDOW)
    await repo.recordUsage(
      { ...KEY, id: 'cyc_2', windowKind: 'weekly' },
      { inputTokens: 100, outputTokens: 20 },
      9000,
      7 * 24 * 60 * 60 * 1000,
    )
    expect(await repo.listByScopeVendor('pooled', 'tok_1', 'claude')).toHaveLength(2)
    expect(await repo.listByScopeVendor('user', 'tok_1', 'claude')).toEqual([])

    // Prunes on the window ANCHOR, so the still-live weekly cycle survives.
    expect(await repo.deleteOlderThan(5000)).toBe(1)
    expect((await repo.listByScopeVendor('pooled', 'tok_1', 'claude')).map((c) => c.id)).toEqual([
      'cyc_2',
    ])
  })
})
