import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { AgentContextSnapshot, AgentSearchQuery, LlmCallMetric } from '@cat-factory/kernel'
import {
  MAX_TELEMETRY_INGEST_CHARS,
  MachineTokenUnavailableError,
  type MachineTelemetryClient,
  type TelemetryIngestRequest,
} from '@cat-factory/server'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './sqlite/telemetryStore.js'
import { sweepTelemetryIngest } from './telemetryIngest.js'

// The UPSTREAM half of the mothership-mode telemetry bucket: carry a QUIESCED run's locally
// captured rows to the mothership. What these assertions pin is the behaviour a live-fire test
// would never reproduce reliably — that quiescence is what selects a run, that the drain pages
// forwards and resumes correctly, and above all that a failed upload leaves the run's high-water
// mark ALONE so the next sweep retries it (the alternative, marking optimistically, loses a run's
// telemetry permanently and silently).

const MINUTE = 60 * 1000
const NOW = 1_000 * MINUTE
/** Older than the sweeper's 10-minute quiescence window. */
const QUIET = NOW - 30 * MINUTE
/** Inside the window — still producing telemetry, so not a candidate. */
const BUSY = NOW - 1 * MINUTE

function metric(id: string, executionId: string, createdAt: number): LlmCallMetric {
  return {
    id,
    workspaceId: 'ws_1',
    executionId,
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
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
  }
}

function snapshot(id: string, executionId: string, createdAt: number): AgentContextSnapshot {
  return {
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
  }
}

function search(id: string, executionId: string, createdAt: number): AgentSearchQuery {
  return {
    id,
    workspaceId: 'ws_1',
    executionId,
    agentKind: 'coder',
    provider: 'searxng',
    query: 'q',
    resultCount: 1,
    createdAt,
  }
}

/** Records every batch it is handed; optionally fails, to drive the retry path. */
class FakeTelemetryClient implements MachineTelemetryClient {
  readonly batches: TelemetryIngestRequest[] = []
  failWith: Error | undefined

  async ingest(batch: TelemetryIngestRequest) {
    if (this.failWith) throw this.failWith
    this.batches.push(batch)
    return {
      metrics: batch.metrics?.length ?? 0,
      snapshots: batch.snapshots?.length ?? 0,
      searchQueries: batch.searchQueries?.length ?? 0,
      toolCalls: batch.toolCalls?.length ?? 0,
    }
  }
}

describe('mothership telemetry ingest sweep', () => {
  let store: LocalTelemetryStore
  let client: FakeTelemetryClient
  const log = createRecordingLogger()

  const sweep = (now = NOW) =>
    sweepTelemetryIngest(
      { reader: store.ingestReader, client, clock: { now: () => now }, log },
      now,
    )

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
    client = new FakeTelemetryClient()
    log.lines.length = 0
  })
  afterEach(() => store.close())

  it('uploads a quiesced run once and never re-offers it', async () => {
    await store.llmCallMetricRepository.record(metric('m1', 'exec_1', QUIET))
    await store.agentContextSnapshotRepository.record(snapshot('s1', 'exec_1', QUIET))
    await store.agentSearchQueryRepository.record(search('q1', 'exec_1', QUIET))

    const first = await sweep()
    expect(first).toMatchObject({ runs: 1, metrics: 1, snapshots: 1, searchQueries: 1, failed: 0 })
    // Every batch names the run it belongs to — the mothership binds that pair and stamps it.
    expect(
      client.batches.every((b) => b.workspaceId === 'ws_1' && b.executionId === 'exec_1'),
    ).toBe(true)

    const second = await sweep()
    expect(second).toMatchObject({ runs: 0, metrics: 0, snapshots: 0, searchQueries: 0 })
  })

  it('leaves a run that is still producing telemetry alone', async () => {
    // Quiescence is what stands in for "finished" — a step thinking between calls must not be
    // mistaken for a settled run, or the run would be uploaded again and again as it continued.
    await store.llmCallMetricRepository.record(metric('m1', 'exec_busy', BUSY))
    expect(await sweep()).toMatchObject({ runs: 0 })

    // Once it goes quiet (the same rows, a later "now"), it uploads.
    expect(await sweep(BUSY + 30 * MINUTE)).toMatchObject({ runs: 1, metrics: 1 })
  })

  it('pages a long run forwards and uploads every row exactly once', async () => {
    // 250 rows against the 200-row page cap: two pages, resumed on the (createdAt, id) keyset.
    // Rows deliberately SHARE a millisecond, which a timestamp-only cursor would silently drop.
    const total = 250
    for (let i = 0; i < total; i += 1) {
      await store.llmCallMetricRepository.record(
        metric(`m${String(i).padStart(3, '0')}`, 'exec_1', QUIET + Math.floor(i / 10)),
      )
    }
    expect(await sweep()).toMatchObject({ runs: 1, metrics: total })
    const uploaded = client.batches.flatMap((b) => b.metrics ?? []).map((m) => m.id)
    expect(uploaded).toHaveLength(total)
    expect(new Set(uploaded).size).toBe(total)
    // Oldest-first, so the mothership rebuilds the run's prompt-delta chain in capture order.
    expect(uploaded).toEqual([...uploaded].sort())
  })

  it('retries a run whose upload failed instead of marking it done', async () => {
    await store.llmCallMetricRepository.record(metric('m1', 'exec_1', QUIET))
    client.failWith = new Error('mothership unreachable')

    const failed = await sweep()
    expect(failed).toMatchObject({ runs: 0, failed: 1 })
    expect(log.lines.some((l) => l.level === 'warn')).toBe(true)

    client.failWith = undefined
    expect(await sweep()).toMatchObject({ runs: 1, metrics: 1, failed: 0 })
  })

  it('does not let one run’s failure park the rest of the backlog', async () => {
    await store.llmCallMetricRepository.record(metric('m1', 'exec_1', QUIET))
    await store.llmCallMetricRepository.record(metric('m2', 'exec_2', QUIET))
    // Fail only the first run's upload; the second must still go.
    let seen = 0
    client.ingest = async (batch: TelemetryIngestRequest) => {
      seen += 1
      if (seen === 1) throw new Error('transient')
      client.batches.push(batch)
      return { metrics: batch.metrics?.length ?? 0, snapshots: 0, searchQueries: 0, toolCalls: 0 }
    }
    expect(await sweep()).toMatchObject({ runs: 1, failed: 1 })
  })

  it('re-uploads a RESUMED run’s new rows once it goes quiet again', async () => {
    await store.llmCallMetricRepository.record(metric('m1', 'exec_1', QUIET))
    expect(await sweep()).toMatchObject({ runs: 1, metrics: 1 })

    // The run picks back up. Its newest row moves past the stored high-water mark, so it becomes
    // a candidate again — the already-uploaded prefix rides along, which is inert because the
    // mothership's append is idempotent by row id.
    const later = NOW + 60 * MINUTE
    await store.llmCallMetricRepository.record(metric('m2', 'exec_1', later - 30 * MINUTE))
    expect(await sweep(later)).toMatchObject({ runs: 1, metrics: 2 })
  })

  it('never marks a run uploaded when the node holds no machine token', async () => {
    // The regression this pins: the client used to answer a token-less node with a zeroed SUCCESS,
    // which the drain read as "every page is stored". The run was marked, stopped being a
    // candidate, and the retention prune then deleted rows the mothership had never seen — the
    // exact silent, permanent loss the failure handling exists to prevent.
    await store.llmCallMetricRepository.record(metric('m1', 'exec_1', QUIET))
    client.failWith = new MachineTokenUnavailableError()

    expect(await sweep()).toMatchObject({ runs: 0, metrics: 0, failed: 1 })

    // Still a candidate once the login completes.
    client.failWith = undefined
    expect(await sweep()).toMatchObject({ runs: 1, metrics: 1, failed: 0 })
    expect(client.batches.flatMap((b) => b.metrics ?? []).map((m) => m.id)).toEqual(['m1'])
  })

  it('stops the whole pass on a missing token instead of failing every run separately', async () => {
    // Every remaining run would fail identically, so the pass ends with one line rather than
    // twenty. Nothing is marked, so the backlog is intact.
    for (const id of ['exec_1', 'exec_2', 'exec_3']) {
      await store.llmCallMetricRepository.record(metric(`m-${id}`, id, QUIET))
    }
    client.failWith = new MachineTokenUnavailableError()
    expect(await sweep()).toMatchObject({ runs: 0, failed: 1 })

    client.failWith = undefined
    expect(await sweep()).toMatchObject({ runs: 3, metrics: 3 })
  })

  it('splits a page into batches that fit the mothership’s BYTE cap', async () => {
    // The row caps bound COUNT; the mothership refuses on bytes too. A page built to the row cap
    // alone can sit permanently over the body cap — 413 forever, the same doomed page every sweep
    // — so the drain budgets by serialized size as well.
    const big = 'x'.repeat(Math.floor(MAX_TELEMETRY_INGEST_CHARS / 3))
    for (let i = 0; i < 6; i += 1) {
      await store.agentContextSnapshotRepository.record({
        ...snapshot(`s${i}`, 'exec_1', QUIET + i),
        systemPrompt: big,
      })
    }
    // One page of 6 rows (under the 20-row cap), but ~2 rows' worth of budget per request.
    expect(await sweep()).toMatchObject({ runs: 1, snapshots: 6, skipped: 0 })
    expect(client.batches.length).toBeGreaterThan(1)
    for (const batch of client.batches) {
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(MAX_TELEMETRY_INGEST_CHARS)
    }
    // Every row still went up, exactly once and in capture order.
    const ids = client.batches.flatMap((b) => b.snapshots ?? []).map((s) => s.id)
    expect(ids).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
  })

  it('skips and REPORTS a row too large to ever post, instead of stalling the run', async () => {
    // A single row over the whole-body cap can never be uploaded. Retrying it would fail the run's
    // drain forever and strand every row behind it; dropping it silently would leave an
    // unexplained hole. So it is skipped, counted, and named in a warning.
    await store.agentContextSnapshotRepository.record({
      ...snapshot('s-huge', 'exec_1', QUIET),
      systemPrompt: 'x'.repeat(MAX_TELEMETRY_INGEST_CHARS + 1),
    })
    await store.agentContextSnapshotRepository.record(snapshot('s-ok', 'exec_1', QUIET + 1))

    expect(await sweep()).toMatchObject({ runs: 1, snapshots: 1, skipped: 1, failed: 0 })
    expect(client.batches.flatMap((b) => b.snapshots ?? []).map((s) => s.id)).toEqual(['s-ok'])
    const warned = log.lines.find(
      (l) => l.level === 'warn' && l.msg.includes('skipped rows over the body cap'),
    )
    expect(warned).toBeDefined()
    expect(String(warned?.fields?.rows)).toContain('s-huge')

    // And the run is DONE — the skip must not make it a permanent candidate.
    expect(await sweep()).toMatchObject({ runs: 0, snapshots: 0 })
  })

  it('ignores an LLM call that resolved no run', async () => {
    // An un-run-scoped inline call is not part of "a finished run's telemetry" and there is
    // nothing to key its upload on, so it must not manufacture a phantom candidate.
    await store.llmCallMetricRepository.record({
      ...metric('m1', 'exec_1', QUIET),
      executionId: null,
    })
    expect(await sweep()).toMatchObject({ runs: 0, metrics: 0 })
  })
})
