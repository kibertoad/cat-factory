import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RetentionConfig } from '@cat-factory/server'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './sqlite/telemetryStore.js'
import { sweepLocalTelemetryRetention } from './telemetryRetention.js'

// The local telemetry prune is the ONLY thing bounding a mothership-mode node's telemetry store:
// the mothership's cron owns its own tables, and the Node facade's retention sweeper runs from
// `start()`, which a mothership-mode boot never calls. So these assertions are about the windows
// being applied to the right tables — a mis-wired window would silently let the heaviest table
// (full per-call prompt + response bodies) grow forever on a developer's disk.

const RETENTION: RetentionConfig = {
  tokenUsageMs: 30 * 24 * 60 * 60 * 1000,
  rateLimitMs: 0,
  commitMs: 0,
  llmCallMetricsMs: 3 * 24 * 60 * 60 * 1000,
  provisioningLogMs: 14 * 24 * 60 * 60 * 1000,
  gateOutcomesMs: 90 * 24 * 60 * 60_000,
  runDaysMs: 400 * 24 * 60 * 60_000,
  notificationsMs: 0,
  // The audit log is never in the LOCAL telemetry store (it is org state the mothership owns),
  // so a window here reaches nothing; named so the config stays exhaustive.
  auditEventsMs: 0,
}

const NOW = 100 * 24 * 60 * 60 * 1000

async function seed(store: LocalTelemetryStore, createdAt: number, id: string): Promise<void> {
  await store.llmCallMetricRepository.record({
    id,
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'claude',
    createdAt,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    spendOnly: false,
    messageCount: 1,
    toolCount: 0,
    requestMaxTokens: null,
    promptTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 1,
    totalTokens: 2,
    finishReason: 'stop',
    upstreamMs: 1,
    overheadMs: 1,
    totalMs: 2,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: id,
    responseText: '',
    reasoningText: '',
  })
  await store.agentContextSnapshotRepository.record({
    id,
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'coder',
    stepIndex: 0,
    createdAt,
    model: null,
    harness: null,
    systemPrompt: '',
    userPrompt: '',
    fragments: [],
    contextFiles: [],
    extras: {},
  })
  await store.agentSearchQueryRepository.record({
    id,
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: null,
    query: 'q',
    resultCount: 0,
    createdAt,
  })
  await store.provisioningLogRepository.append({
    id,
    workspaceId: 'ws_1',
    subsystem: 'container',
    operation: 'dispatch',
    targetId: null,
    providerId: null,
    blockId: null,
    executionId: 'exec_1',
    outcome: 'success',
    error: null,
    detail: null,
    createdAt,
  })
}

describe('sweepLocalTelemetryRetention', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => store.close())

  it('prunes the three agent sinks on the LLM window and the log on its own', async () => {
    // 7 days old: past the 3-day LLM window, still inside the 14-day provisioning one.
    await seed(store, NOW - 7 * 24 * 60 * 60 * 1000, 'week_old')
    await seed(store, NOW - 60 * 60 * 1000, 'fresh')

    expect(await sweepLocalTelemetryRetention(store, RETENTION, NOW)).toEqual({
      llmCallMetrics: 1,
      agentContextSnapshots: 1,
      agentSearchQueries: 1,
      provisioningLog: 0,
      subscriptionQuotaCycles: 0,
      ingestState: 0,
      // The run kept its fresh rows, so it is now a SUBSET locally and its marker stands. Nothing
      // to forget yet — see the next test for the other half of the marker's life.
      prunedRunMarkers: 0,
    })
    expect((await store.llmCallMetricRepository.listByExecution('ws_1', 'exec_1')).length).toBe(1)
    expect((await store.provisioningLogRepository.list('ws_1')).length).toBe(2)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exec_1')).toBe(false)
  })

  it('marks a partially pruned run, then forgets the marker once its last row is gone', async () => {
    // The marker is what stops the read-through answering a pruned run with the suffix it kept —
    // a short list, and worse, a token total that is simply too low with nothing saying so. It is
    // swept EXACTLY (no rows left anywhere), never on a window: ageing it out on a duration would
    // expire it while the run's surviving rows were still being answered with.
    await seed(store, NOW - 7 * 24 * 60 * 60 * 1000, 'week_old')
    await seed(store, NOW - 60 * 60 * 1000, 'fresh')
    await sweepLocalTelemetryRetention(store, RETENTION, NOW)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exec_1')).toBe(false)

    // A later sweep, far enough on that the run's remaining rows go too: now there is nothing for
    // the marker to qualify, and the read-through's emptiness gate covers the run instead.
    const later = NOW + 30 * 24 * 60 * 60 * 1000
    expect((await sweepLocalTelemetryRetention(store, RETENTION, later)).prunedRunMarkers).toBe(1)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exec_1')).toBe(true)
  })

  it('prunes an ingest high-water mark on the LLM window, never before its rows', async () => {
    // The mark is stamped at ingest time, which is at or after the newest row it covers, so it
    // outlives them. Dropping it early would make a still-stored run look un-ingested and
    // re-upload the whole thing.
    await seed(store, NOW - 7 * 24 * 60 * 60 * 1000, 'week_old')
    store.ingestReader.markIngested('ws_1', 'exec_1', NOW - 7 * 24 * 60 * 60 * 1000, NOW - 1000)
    expect((await sweepLocalTelemetryRetention(store, RETENTION, NOW)).ingestState).toBe(0)
    expect(store.ingestReader.listPendingRuns(NOW, 10)).toEqual([])

    store.ingestReader.markIngested('ws_1', 'exec_2', 1, NOW - 7 * 24 * 60 * 60 * 1000)
    expect((await sweepLocalTelemetryRetention(store, RETENTION, NOW)).ingestState).toBe(1)
  })

  it('treats a non-positive window as disabled rather than as "delete everything"', async () => {
    await seed(store, 1000, 'ancient')
    const disabled: RetentionConfig = { ...RETENTION, llmCallMetricsMs: 0, provisioningLogMs: 0 }

    const reclaimed = await sweepLocalTelemetryRetention(store, disabled, NOW)
    expect(reclaimed.llmCallMetrics).toBe(0)
    expect(reclaimed.provisioningLog).toBe(0)
    expect((await store.llmCallMetricRepository.listByExecution('ws_1', 'exec_1')).length).toBe(1)
  })

  it('prunes an idle quota cycle only well past the longest quota window', async () => {
    const key = {
      id: 'cyc_1',
      scope: 'pooled',
      scopeId: 'tok_1',
      vendor: 'claude',
      windowKind: '5h',
    } as const
    // A cycle anchored 8 days ago: long since reset, but well inside the fixed 30-day prune, so a
    // sweep must NOT touch it (the window it models is only re-anchored on next use).
    await store.subscriptionQuotaCycleRepository.recordUsage(
      key,
      { inputTokens: 1, outputTokens: 1 },
      NOW - 8 * 24 * 60 * 60 * 1000,
      5 * 60 * 60 * 1000,
    )
    expect(
      (await sweepLocalTelemetryRetention(store, RETENTION, NOW)).subscriptionQuotaCycles,
    ).toBe(0)

    const later = NOW + 31 * 24 * 60 * 60 * 1000
    expect(
      (await sweepLocalTelemetryRetention(store, RETENTION, later)).subscriptionQuotaCycles,
    ).toBe(1)
  })
})
