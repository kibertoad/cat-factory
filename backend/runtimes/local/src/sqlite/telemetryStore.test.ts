import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentContextSnapshot, AgentSearchQuery, LlmCallMetric } from '@cat-factory/kernel'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './telemetryStore.js'

// What is LOCAL-ONLY about the mothership-mode `node:sqlite` telemetry store.
//
// The cross-store behaviour (every repository's round-trip, ordering, keyset paging, body
// budgets, idempotency, pruning) is asserted by the SHARED conformance suites, which this store
// now runs alongside D1 and Postgres: see the `*.conformance.test.ts` siblings in this directory.
// A property all three stores must agree about belongs THERE, so a fix cannot land in one store
// and miss the others. What is left here is what only this store has to answer for:
//   - `recordMany` holds its BEGIN/COMMIT without yielding, because `node:sqlite` is synchronous
//     and an `await` inside the transaction would let a second batch nest a BEGIN;
//   - `deleteOlderThan` reports the EXACT number of rows it reclaimed, which the shared suite
//     cannot assert (its database is shared across cases, so it can only bound the count);
//   - `SqliteTelemetryIngestReader`, the mothership upload path, which exists on no other store.

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
    spendOnly: false,
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

  it('holds its batch transaction without yielding, so two batches cannot interleave', async () => {
    // `recordMany` wraps its inserts in BEGIN/COMMIT, and the inserts must be SYNCHRONOUS for that
    // to mean anything: an `await` inside the transaction yields the microtask queue, so a second
    // batch starting there would hit a nested BEGIN (a hard SQLite error) and a concurrent
    // single-row `record` would land inside this transaction and be rolled back with it.
    const repo = store.llmCallMetricRepository
    const first = repo.recordMany([metric({ id: 'a1' }), metric({ id: 'a2' })])
    const second = repo.recordMany([metric({ id: 'b1' }), metric({ id: 'b2' })])
    await expect(Promise.all([first, second])).resolves.toBeDefined()
    const ids = (await repo.listByExecution('ws_1', 'exec_1')).map((r) => r.id).sort()
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('prunes by age and reports how many rows it reclaimed', async () => {
    const repo = store.llmCallMetricRepository
    await repo.record(metric({ id: 'old', createdAt: 500 }))
    await repo.record(metric({ id: 'new', createdAt: 5000 }))
    expect(await repo.deleteOlderThan(1000)).toBe(1)
    expect((await repo.listByExecution('ws_1', 'exec_1')).map((m) => m.id)).toEqual(['new'])
  })
})

describe('SqliteTelemetryIngestReader', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  const snap = (id: string, executionId: string, createdAt: number): AgentContextSnapshot => ({
    id,
    workspaceId: 'ws_1',
    executionId,
    agentKind: 'coder',
    stepIndex: 0,
    createdAt,
    model: 'anthropic:claude',
    harness: 'pi',
    systemPrompt: 'system',
    userPrompt: 'user',
    fragments: [],
    contextFiles: [],
    extras: {},
  })

  it('selects only runs quiet since the cutoff, oldest-quiescence first', async () => {
    await store.llmCallMetricRepository.record(
      metric({ id: 'a', executionId: 'exec_old', createdAt: 100 }),
    )
    await store.llmCallMetricRepository.record(
      metric({ id: 'b', executionId: 'exec_recent', createdAt: 500 }),
    )
    // Still producing past the cutoff — not a candidate.
    await store.llmCallMetricRepository.record(
      metric({ id: 'c', executionId: 'exec_busy', createdAt: 5_000 }),
    )

    const pending = store.ingestReader.listPendingRuns(1_000, 10)
    expect(pending.map((r) => r.executionId)).toEqual(['exec_old', 'exec_recent'])
    expect(pending[0]).toEqual({ workspaceId: 'ws_1', executionId: 'exec_old', lastWriteAt: 100 })
  })

  it('takes a run’s high-water mark from the NEWEST row across all three sinks', async () => {
    // A run whose last activity was a snapshot (not an LLM call) must still be held back until
    // that snapshot is old enough — otherwise it uploads mid-run and re-uploads on every sweep.
    await store.llmCallMetricRepository.record(
      metric({ id: 'a', executionId: 'exec_1', createdAt: 100 }),
    )
    await store.agentContextSnapshotRepository.record(snap('s1', 'exec_1', 900))

    expect(store.ingestReader.listPendingRuns(500, 10)).toEqual([])
    expect(store.ingestReader.listPendingRuns(1_000, 10)[0]?.lastWriteAt).toBe(900)
  })

  it('stops offering a run once marked, and offers it again when it produces more', async () => {
    await store.llmCallMetricRepository.record(
      metric({ id: 'a', executionId: 'exec_1', createdAt: 100 }),
    )
    store.ingestReader.markIngested('ws_1', 'exec_1', 100, 100)
    expect(store.ingestReader.listPendingRuns(1_000, 10)).toEqual([])

    await store.llmCallMetricRepository.record(
      metric({ id: 'b', executionId: 'exec_1', createdAt: 200 }),
    )
    expect(store.ingestReader.listPendingRuns(1_000, 10)[0]?.lastWriteAt).toBe(200)
  })

  it('never walks a high-water mark backwards', async () => {
    await store.llmCallMetricRepository.record(
      metric({ id: 'a', executionId: 'exec_1', createdAt: 300 }),
    )
    store.ingestReader.markIngested('ws_1', 'exec_1', 300, 300)
    // A slower concurrent sweep reporting an older mark must not re-open the run.
    store.ingestReader.markIngested('ws_1', 'exec_1', 100, 400)
    expect(store.ingestReader.listPendingRuns(1_000, 10)).toEqual([])
  })

  it('pages a sink forwards on the composite keyset, including a shared millisecond', async () => {
    for (const id of ['a', 'b', 'c']) {
      await store.llmCallMetricRepository.record(
        metric({ id, executionId: 'exec_1', createdAt: 100 }),
      )
    }
    const first = store.ingestReader.listMetrics('ws_1', 'exec_1', undefined, 2)
    expect(first.map((m) => m.id)).toEqual(['a', 'b'])
    const last = first[first.length - 1]!
    const second = store.ingestReader.listMetrics(
      'ws_1',
      'exec_1',
      { createdAt: last.createdAt, id: last.id },
      2,
    )
    // A createdAt-only cursor would have skipped 'c' entirely — they share the millisecond.
    expect(second.map((m) => m.id)).toEqual(['c'])
  })

  it('scopes every page to its run, with whole bodies', async () => {
    await store.llmCallMetricRepository.record(
      metric({ id: 'a', executionId: 'exec_1', promptText: 'the whole prompt' }),
    )
    await store.llmCallMetricRepository.record(metric({ id: 'b', executionId: 'exec_2' }))
    const rows = store.ingestReader.listMetrics('ws_1', 'exec_1', undefined, 10)
    expect(rows.map((m) => m.id)).toEqual(['a'])
    // Unlike the debug API's bounded pages, ingest moves the stored bytes verbatim.
    expect(rows[0]?.promptText).toBe('the whole prompt')
  })

  it('batch-appends each sink, ignoring ids it already holds', async () => {
    await store.llmCallMetricRepository.recordMany([
      metric({ id: 'a', executionId: 'exec_1', promptText: 'first' }),
      metric({ id: 'b', executionId: 'exec_1' }),
    ])
    await store.llmCallMetricRepository.recordMany([
      metric({ id: 'a', executionId: 'exec_1', promptText: 'second' }),
    ])
    const rows = store.ingestReader.listMetrics('ws_1', 'exec_1', undefined, 10)
    expect(rows.map((m) => m.id)).toEqual(['a', 'b'])
    expect(rows[0]?.promptText).toBe('first')

    await store.agentContextSnapshotRepository.recordMany([snap('s1', 'exec_1', 1)])
    await store.agentContextSnapshotRepository.recordMany([snap('s1', 'exec_1', 1)])
    expect(await store.agentContextSnapshotRepository.countByExecution('ws_1', 'exec_1')).toBe(1)

    const q: AgentSearchQuery = {
      id: 'q1',
      workspaceId: 'ws_1',
      executionId: 'exec_1',
      agentKind: 'coder',
      provider: 'searxng',
      query: 'q',
      resultCount: 1,
      createdAt: 1,
    }
    await store.agentSearchQueryRepository.recordMany([q])
    await store.agentSearchQueryRepository.recordMany([q])
    expect(await store.agentSearchQueryRepository.countByExecution('ws_1', 'exec_1')).toBe(1)
  })

  it('prunes ingest marks by age', () => {
    store.ingestReader.markIngested('ws_1', 'exec_old', 1, 100)
    store.ingestReader.markIngested('ws_1', 'exec_new', 1, 5_000)
    expect(store.ingestReader.deleteIngestStateOlderThan(1_000)).toBe(1)
  })
})
