import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { AgentContextSnapshot, AgentSearchQuery, LlmCallMetric } from '@cat-factory/kernel'
import {
  TelemetryReadTooLargeError,
  type MachineTelemetryReadClient,
  type TelemetryReadRequest,
} from '@cat-factory/server'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './sqlite/telemetryStore.js'
import { withTelemetryReadThrough } from './telemetryReadThrough.js'

// The DOWNSTREAM half of the mothership-mode telemetry bucket: a run whose rows this node does
// not hold — pruned, or driven by somebody else — is rendered from the mothership's copy instead
// of as an empty panel indistinguishable from a run that spent nothing.
//
// What these assertions pin is the behaviour the wiring alone would not give you: that a local
// hit NEVER costs a round trip (the capture path stays local-only), that an empty local answer
// falls through and DRAINS the remote pages correctly, that a remote failure propagates rather
// than degrading back into the empty answer it was called to replace, and that the writes are
// never decorated at all.

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
    promptHash: `h-${id}`,
    responseText: 'ok',
    reasoningText: '',
    reportedCostUsd: null,
    upstreamProvider: null,
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

/** A stand-in mothership holding a run's rows, recording every request it was asked. */
function fakeMothership(rows: {
  metrics?: LlmCallMetric[]
  snapshots?: AgentContextSnapshot[]
  searchQueries?: AgentSearchQuery[]
  fail?: boolean
  /**
   * Refuse any page asking for more than this many rows, as a real mothership does when the rows
   * it would return serialize past its byte backstop. A ROW count stands in for the byte cap here
   * only to make the condition reproducible — what is under test is the client's reaction to the
   * typed refusal, not the mothership's arithmetic (`telemetryRead.spec.ts` pins that).
   */
  tooLargeAbove?: number
}) {
  const seen: TelemetryReadRequest[] = []
  const client: MachineTelemetryReadClient = {
    async read(request) {
      seen.push(request)
      if (rows.fail) throw new Error('mothership unreachable')
      const asked = (request.args[0] as { limit?: number } | undefined)?.limit
      if (rows.tooLargeAbove != null && asked != null && asked > rows.tooLargeAbove) {
        throw new TelemetryReadTooLargeError('result too large')
      }
      const query = request.args[0] as
        | { executionId?: string; limit?: number; cursor?: { createdAt: number; id: string } }
        | undefined
      // `executionId` is nullable on a metric (an inline call that resolved no run), so the
      // constraint has to allow it — such a row simply never matches a run-scoped query.
      const page = <T extends { id: string; createdAt: number; executionId: string | null }>(
        all: T[],
      ) => {
        // Newest-first on the `(createdAt, id)` composite, exactly as every store orders it.
        const ordered = all
          .filter((r) => r.executionId === query?.executionId)
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        const after = query?.cursor
          ? ordered.filter(
              (r) =>
                r.createdAt < query.cursor!.createdAt ||
                (r.createdAt === query.cursor!.createdAt && r.id < query.cursor!.id),
            )
          : ordered
        return after.slice(0, query?.limit ?? after.length)
      }
      const key = `${request.repo}.${request.method}`
      if (key === 'llmCallMetricRepository.listRunPage') return page(rows.metrics ?? [])
      if (key === 'agentContextSnapshotRepository.listRunPage') return page(rows.snapshots ?? [])
      if (key === 'agentSearchQueryRepository.listPage') return page(rows.searchQueries ?? [])
      if (key === 'llmCallMetricRepository.summarizeByExecution') {
        return [{ agentKind: 'coder', phase: 'agent', calls: 7 }]
      }
      if (key === 'agentContextSnapshotRepository.countByExecution') return 4
      if (key === 'agentSearchQueryRepository.countByExecution') return 2
      if (key === 'agentContextSnapshotRepository.get') return (rows.snapshots ?? [])[0] ?? null
      if (key === 'llmCallMetricRepository.get') return { id: 'remote-call' }
      if (key === 'llmCallMetricRepository.listPage') return [{ id: 'remote-page' }]
      if (key === 'agentContextSnapshotRepository.listIndex') return [{ id: 'remote-index' }]
      throw new Error(`unexpected read: ${key}`)
    },
  }
  return { client, seen }
}

describe('mothership-mode telemetry read-through', () => {
  let store: LocalTelemetryStore

  beforeEach(() => {
    store = createLocalTelemetryStore(':memory:')
  })
  afterEach(() => {
    store.close()
  })

  it('serves a run the LOCAL store holds without touching the mothership', async () => {
    // The run this node is driving. Its rows are here, they are fresher than anything the ingest
    // could have carried up, and a round trip would be pure waste.
    const { client, seen } = fakeMothership({ metrics: [metric('m-remote', 'exe_1', 5)] })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })
    await store.llmCallMetricRepository.record(metric('m-local', 'exe_1', 10))
    await store.agentContextSnapshotRepository.record(snapshot('s-local', 'exe_1', 10))
    await store.agentSearchQueryRepository.record(search('q-local', 'exe_1', 10))

    expect(
      (await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_1')).map((m) => m.id),
    ).toEqual(['m-local'])
    expect(
      (await repos.agentContextSnapshotRepository.listByExecution('ws_1', 'exe_1')).map(
        (s) => s.id,
      ),
    ).toEqual(['s-local'])
    expect(
      (await repos.agentSearchQueryRepository.listByExecution('ws_1', 'exe_1')).map((q) => q.id),
    ).toEqual(['q-local'])
    expect(await repos.agentContextSnapshotRepository.countByExecution('ws_1', 'exe_1')).toBe(1)
    expect(seen).toHaveLength(0)
  })

  it('drains the mothership when the local store holds nothing for the run', async () => {
    // Either of the two runs that render blank today: one whose local rows were pruned, or one
    // another node drove entirely (the common case — a mothership-mode SPA shows the whole org).
    const remote = [
      metric('m1', 'exe_far', 10),
      metric('m2', 'exe_far', 20),
      metric('m3', 'exe_far', 30),
      // A different run's row, which must never leak into this one's answer.
      metric('m-other', 'exe_other', 40),
    ]
    const { client, seen } = fakeMothership({ metrics: remote })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    const calls = await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_far')
    expect(calls.map((m) => m.id)).toEqual(['m3', 'm2', 'm1'])
    // Whole rows, not a projection — the panel renders bodies.
    expect(calls[0]?.responseText).toBe('ok')
    expect(seen.every((r) => r.workspaceId === 'ws_1')).toBe(true)
    // The rollup and the counts fall through the same way, so a board counter is not a false zero.
    expect(
      await repos.llmCallMetricRepository.summarizeByExecution('ws_1', 'exe_far'),
    ).toHaveLength(1)
    expect(await repos.agentContextSnapshotRepository.countByExecution('ws_1', 'exe_far')).toBe(4)
    expect(await repos.agentSearchQueryRepository.countByExecution('ws_1', 'exe_far')).toBe(2)
  })

  it('pages the drain forwards across a shared millisecond', async () => {
    // Snapshots page ONE at a time (their rows are megabytes apiece), so a 7-row run needs seven
    // requests — and two of its rows share a createdAt, which a timestamp-only cursor would drop
    // from the next page entirely.
    const snapshots = [
      snapshot('s1', 'exe_far', 10),
      snapshot('s2', 'exe_far', 20),
      snapshot('s3', 'exe_far', 20),
      snapshot('s4', 'exe_far', 30),
      snapshot('s5', 'exe_far', 40),
      snapshot('s6', 'exe_far', 50),
      snapshot('s7', 'exe_far', 60),
    ]
    const { client, seen } = fakeMothership({ snapshots })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    const got = await repos.agentContextSnapshotRepository.listByExecution('ws_1', 'exe_far')
    expect(got.map((s) => s.id)).toEqual(['s7', 's6', 's5', 's4', 's3', 's2', 's1'])
    // Seven full pages, then an eighth that comes back empty — a SHORT page is what terminates
    // the drain, and at a page size of 1 only an empty one is short.
    expect(seen).toHaveLength(8)
    expect(seen[0]!.args[0]).toMatchObject({ executionId: 'exe_far', limit: 1 })
    // The tie: having just taken s3 at createdAt 20, the next cursor must still reach s2 at the
    // SAME createdAt. A timestamp-only cursor would skip it and the run would silently lose a row.
    expect(seen[5]!.args[0]).toMatchObject({ cursor: { createdAt: 20, id: 's3' } })
    expect(got.map((s) => s.id)).toContain('s2')
  })

  it('honours a caller’s own limit as the drain cap', async () => {
    // Kaizen and the observability panel both pass one; the drain must not fetch past it.
    const metrics = Array.from({ length: 10 }, (_, i) => metric(`m${i}`, 'exe_far', 100 + i))
    const { client, seen } = fakeMothership({ metrics })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    const got = await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_far', 4)
    expect(got).toHaveLength(4)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.args[0]).toMatchObject({ limit: 4 })
  })

  it('STITCHES a run the prune took the older half of, rather than answering with the half it kept', async () => {
    // The third blank-run case, and the one an emptiness gate cannot see: the prune deletes by
    // `created_at`, so a run straddling the cutoff keeps its newer rows and loses its older ones.
    // The store then ANSWERS — nothing looks missing — with a strict subset.
    await store.llmCallMetricRepository.record(metric('m-old', 'exe_split', 10))
    await store.llmCallMetricRepository.record(metric('m-new', 'exe_split', 90))
    // The real prune, so the marking path under test is the one production runs.
    expect(await store.llmCallMetricRepository.deleteOlderThan(50)).toBe(1)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exe_split')).toBe(false)

    const { client, seen } = fakeMothership({
      metrics: [metric('m-old', 'exe_split', 10), metric('m-new', 'exe_split', 90)],
    })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    // Local's surviving suffix, then everything strictly older from the mothership — disjoint by
    // construction, because the cursor is local's oldest row.
    const calls = await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_split')
    expect(calls.map((m) => m.id)).toEqual(['m-new', 'm-old'])
    expect(seen[0]!.args[0]).toMatchObject({ cursor: { createdAt: 90, id: 'm-new' } })
  })

  it('takes a partially pruned run’s ROLLUP and counts from the mothership, never the local subset', async () => {
    // The sharpest form of the same defect. A short list at least looks like a list; an
    // understated token total is a number, and a number carries no hint that it is short — so the
    // board would report a pruned run as having spent a fraction of what it did.
    await store.llmCallMetricRepository.record(metric('m-old', 'exe_split', 10))
    await store.llmCallMetricRepository.record(metric('m-new', 'exe_split', 90))
    await store.agentContextSnapshotRepository.record(snapshot('s-old', 'exe_split', 10))
    await store.agentContextSnapshotRepository.record(snapshot('s-new', 'exe_split', 90))
    await store.llmCallMetricRepository.deleteOlderThan(50)
    await store.agentContextSnapshotRepository.deleteOlderThan(50)

    const { client, seen } = fakeMothership({})
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    // The mothership's aggregate is the whole run's; the two are never merged, because nothing in
    // either says which rows they share.
    const cells = await repos.llmCallMetricRepository.summarizeByExecution('ws_1', 'exe_split')
    expect(cells).toEqual([{ agentKind: 'coder', phase: 'agent', calls: 7 }])
    expect(await repos.agentContextSnapshotRepository.countByExecution('ws_1', 'exe_split')).toBe(4)
    expect(seen.map((r) => r.method)).toEqual(['summarizeByExecution', 'countByExecution'])
  })

  it('forgets the marker once the run has no local rows left, and trusts local again after', async () => {
    // A marker earns its keep only while the store answers with a subset. Once the last row is
    // gone the emptiness gate already falls through, so keeping it would be pure growth — and
    // sweeping it is exact rather than time-based, or it would expire while still load-bearing.
    await store.llmCallMetricRepository.record(metric('m-old', 'exe_gone', 10))
    await store.llmCallMetricRepository.deleteOlderThan(50)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exe_gone')).toBe(false)
    expect(store.coverage.forgetSettledRuns()).toBe(1)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exe_gone')).toBe(true)

    // A run that still holds rows keeps its marker through the same sweep.
    await store.llmCallMetricRepository.record(metric('m-old', 'exe_split', 10))
    await store.llmCallMetricRepository.record(metric('m-new', 'exe_split', 90))
    await store.llmCallMetricRepository.deleteOlderThan(50)
    expect(store.coverage.forgetSettledRuns()).toBe(0)
    expect(store.coverage.isRunLocallyComplete('ws_1', 'exe_split')).toBe(false)
  })

  it('does not report a cap it never reached when local already filled the allowance', async () => {
    // A partially pruned run whose surviving suffix already covers the caller's limit has no
    // remainder to fetch. The drain must say nothing: a "capped a run's calls" warning about a
    // complete answer is the noise that teaches a reader to ignore the real one.
    const recording = createRecordingLogger()
    await store.llmCallMetricRepository.record(metric('m-old', 'exe_split', 10))
    await store.llmCallMetricRepository.record(metric('m-new', 'exe_split', 90))
    await store.llmCallMetricRepository.deleteOlderThan(50)
    const { client, seen } = fakeMothership({})
    const repos = withTelemetryReadThrough(store, {
      client,
      coverage: store.coverage,
      logger: recording,
    })

    expect(
      (await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_split', 1)).map(
        (m) => m.id,
      ),
    ).toEqual(['m-new'])
    expect(seen).toHaveLength(0)
    expect(recording.lines.filter((e) => e.level === 'warn')).toEqual([])
  })

  it('HALVES a page the mothership refuses for size rather than failing the run', async () => {
    // A page inside its row cap can still serialize past the byte backstop — three whole snapshots
    // at the capture ceiling are ~12 MiB. Refusing is right (a shortened page would be read as the
    // end of the run); giving up is not, because the same run would then never render at all.
    const recording = createRecordingLogger()
    const metrics = Array.from({ length: 3 }, (_, i) => metric(`m${i}`, 'exe_far', 10 + i))
    const { client, seen } = fakeMothership({ metrics, tooLargeAbove: 2 })
    const repos = withTelemetryReadThrough(store, {
      client,
      coverage: store.coverage,
      logger: recording,
    })

    const got = await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_far')
    // Every row still arrives: the cursor never advanced over the refused page, so narrowing lost
    // nothing.
    expect(got.map((m) => m.id)).toEqual(['m2', 'm1', 'm0'])
    expect(seen.map((r) => (r.args[0] as { limit: number }).limit)).toEqual([
      100, 50, 25, 12, 6, 3, 1, 1, 1, 1,
    ])
    expect(recording.lines.some((e) => e.level === 'debug' && e.fields?.what === 'calls')).toBe(
      true,
    )
  })

  it('asks a point read for the declared body ceiling when its caller named no window', async () => {
    // An absent window means "the whole bodies" to the port, which is the unstated size the
    // machine surface refuses — so passing the caller's `undefined` through would turn a
    // legitimate local miss into a 422 rather than a rendered call.
    const { client, seen } = fakeMothership({})
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    await repos.llmCallMetricRepository.get('ws_1', 'call-elsewhere')
    expect(seen[0]!.args).toEqual(['call-elsewhere', { chars: 262_144 }])
    // A caller that DID name one keeps it.
    await repos.llmCallMetricRepository.get('ws_1', 'call-elsewhere', { chars: 100, offset: 5 })
    expect(seen[1]!.args[1]).toEqual({ chars: 100, offset: 5 })
  })

  it('stitches a partially pruned run across the two stores when paging', async () => {
    // The keyset composes: local answers while it can, and the first page it cannot fill falls
    // through with the SAME cursor — exact, because the ingest preserves each row's id and
    // createdAt. So a run whose oldest rows were pruned reads continuously rather than stopping
    // at the seam.
    await store.agentSearchQueryRepository.record(search('q-new', 'exe_far', 90))
    const { client, seen } = fakeMothership({
      searchQueries: [search('q-new', 'exe_far', 90), search('q-old', 'exe_far', 10)],
    })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    const first = await repos.agentSearchQueryRepository.listPage('ws_1', {
      executionId: 'exe_far',
      limit: 1,
    })
    expect(first.map((q) => q.id)).toEqual(['q-new'])
    expect(seen).toHaveLength(0)
    const second = await repos.agentSearchQueryRepository.listPage('ws_1', {
      executionId: 'exe_far',
      limit: 1,
      cursor: { createdAt: first[0]!.createdAt, id: first[0]!.id },
    })
    expect(second.map((q) => q.id)).toEqual(['q-old'])
    expect(seen).toHaveLength(1)
  })

  it('THROWS when the mothership cannot answer, never a false empty', async () => {
    // The defect being fixed is that "no rows here" and "no rows anywhere" render identically, so
    // a swallowed failure would reinstate it with an extra step. The one hot-path caller
    // (`RunStateMachine.attachStepMetrics`) already treats a metrics read as best-effort.
    const { client } = fakeMothership({ fail: true })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })
    await expect(repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_far')).rejects.toThrow(
      /unreachable/,
    )
    await expect(
      repos.agentContextSnapshotRepository.countByExecution('ws_1', 'exe_far'),
    ).rejects.toThrow(/unreachable/)
  })

  it('never decorates capture, the chain tip or the prune', async () => {
    // Capture is the hot path this whole bucket exists to keep off the network; the chain tip
    // must resolve against the rows THIS node holds, or it would store a prompt delta against a
    // tip it cannot reproduce; and the prune owns local rows only.
    const { client, seen } = fakeMothership({ metrics: [metric('m-remote', 'exe_far', 5)] })
    const repos = withTelemetryReadThrough(store, { client, coverage: store.coverage })

    await repos.llmCallMetricRepository.record(metric('m-local', 'exe_1', 10))
    await repos.agentContextSnapshotRepository.recordMany([snapshot('s-local', 'exe_1', 10)])
    await repos.agentSearchQueryRepository.recordMany([search('q-local', 'exe_1', 10)])
    // A run with no local rows: the tip is null and stays null rather than reaching upstream.
    expect(
      await repos.llmCallMetricRepository.latestChainTip('ws_1', 'exe_far', 'coder'),
    ).toBeNull()
    expect(await repos.llmCallMetricRepository.deleteOlderThan(0)).toBe(0)
    expect(seen).toHaveLength(0)
    // The writes landed in the LOCAL store, not somewhere the decorator invented.
    expect(await store.agentContextSnapshotRepository.countByExecution('ws_1', 'exe_1')).toBe(1)
  })

  it('reports a drain it had to cap rather than returning a short list as the whole run', async () => {
    // "Every cap records what it dropped": a list that quietly stops partway reads to whoever is
    // looking at the panel as the entire run.
    const recording = createRecordingLogger()
    const metrics = Array.from({ length: 6 }, (_, i) => metric(`m${i}`, 'exe_far', 100 + i))
    const { client } = fakeMothership({ metrics })
    const repos = withTelemetryReadThrough(store, {
      client,
      coverage: store.coverage,
      logger: recording,
    })

    // Cap the drain via the caller's own limit, which is the same code path the default cap takes.
    await repos.llmCallMetricRepository.listByExecution('ws_1', 'exe_far', 3)
    expect(
      recording.lines.some(
        (e) => e.level === 'warn' && e.fields?.executionId === 'exe_far' && e.fields?.cap === 3,
      ),
    ).toBe(true)
  })
})
