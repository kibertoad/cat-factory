import { describe, expect, it, vi } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import { PLATFORM_ATTR, PLATFORM_METRIC } from './mapping.js'
import { PlatformMetricsOtelExporter } from './platform.js'

// The platform-metrics exporter POSTs OTLP/JSON gauges to the collector over its injectable
// `fetchImpl`. We inject a capturing stub so the assertions are deterministic and independent
// of the environment's `fetch` — same shape as `index.test.ts`.
const COLLECTOR = 'http://collector.test:4318'

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function capturingFetch(): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

interface KV {
  key: string
  value: Record<string, unknown>
}
function attrMap(kvs: KV[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const kv of kvs) {
    const v = kv.value
    out[kv.key] =
      'stringValue' in v
        ? v.stringValue
        : 'intValue' in v
          ? Number(v.intValue)
          : 'doubleValue' in v
            ? v.doubleValue
            : undefined
  }
  return out
}

function metricsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const rm = (body.resourceMetrics as Record<string, unknown>[])[0]!
  const sm = (rm.scopeMetrics as Record<string, unknown>[])[0]!
  return sm.metrics as Record<string, unknown>[]
}
function gaugePoints(metric: Record<string, unknown>): Record<string, unknown>[] {
  return (metric.gauge as { dataPoints: Record<string, unknown>[] }).dataPoints
}
function resourceServiceName(body: Record<string, unknown>): unknown {
  const rm = (body.resourceMetrics as Record<string, unknown>[])[0]!
  return attrMap((rm.resource as { attributes: KV[] }).attributes)['service.name']
}

function snapshot(overrides: Partial<PlatformObservability> = {}): PlatformObservability {
  return {
    window: '1h',
    generatedAt: 1_700_000_000_000,
    since: 1_700_000_000_000 - 3_600_000,
    outcomes: {
      total: 10,
      done: 6,
      failed: 2,
      running: 1,
      blocked: 1,
      paused: 0,
      other: 0,
      successRate: 0.75,
    },
    trend: { bucketMs: 300_000, points: [] },
    failures: [
      { kind: 'agent', count: 1 },
      { kind: 'timeout', count: 1 },
    ],
    live: { running: 3, blocked: 2, paused: 1, pending: 4 },
    durations: {
      count: 8,
      avgMs: 120_000,
      minMs: 30_000,
      maxMs: 300_000,
      p50Ms: 90_000,
      p90Ms: 250_000,
      p99Ms: 300_000,
    },
    ...overrides,
  }
}

describe('PlatformMetricsOtelExporter (fetch OTLP gauges)', () => {
  it('posts platform gauges to /v1/metrics with account + window dimensions', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = new PlatformMetricsOtelExporter({
      endpoint: `${COLLECTOR}/`,
      headers: { 'x-api-key': 'secret' },
      serviceName: 'cat-factory-test',
      fetchImpl,
    })

    await exporter.export(snapshot(), { accountId: 'acc-1' })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    // Trailing slash normalised → exactly `/v1/metrics`.
    expect(call.url).toBe(`${COLLECTOR}/v1/metrics`)
    expect(call.headers['x-api-key']).toBe('secret')
    expect(call.headers['content-type']).toContain('application/json')
    expect(resourceServiceName(call.body)).toBe('cat-factory-test')

    const metrics = metricsOf(call.body)
    const byName = new Map(metrics.map((m) => [String(m.name), m]))
    expect([...byName.keys()].sort()).toEqual(
      [
        PLATFORM_METRIC.liveRuns,
        PLATFORM_METRIC.runDuration,
        PLATFORM_METRIC.runFailures,
        PLATFORM_METRIC.runSuccessRate,
        PLATFORM_METRIC.runs,
      ].sort(),
    )

    // Every point is stamped with the snapshot's generatedAt (no wall-clock read).
    for (const m of metrics) {
      for (const p of gaugePoints(m)) expect(p.timeUnixNano).toBe('1700000000000000000')
    }

    // runs: one int point per status, windowed + account-scoped.
    const runs = byName.get('cat_factory.platform.runs')!
    expect(runs.unit).toBe('{run}')
    const runsByStatus = Object.fromEntries(
      gaugePoints(runs).map((p) => {
        const a = attrMap(p.attributes as KV[])
        expect(a[PLATFORM_ATTR.accountId]).toBe('acc-1')
        expect(a[PLATFORM_ATTR.window]).toBe('1h')
        return [a[PLATFORM_ATTR.runStatus], Number(p.asInt)]
      }),
    )
    expect(runsByStatus).toEqual({
      done: 6,
      failed: 2,
      running: 1,
      blocked: 1,
      paused: 0,
      other: 0,
    })

    // success rate: a single double point, no run_status split.
    const rate = byName.get('cat_factory.platform.run_success_rate')!
    expect(rate.unit).toBe('1')
    expect(gaugePoints(rate)).toHaveLength(1)
    expect((gaugePoints(rate)[0] as { asDouble: number }).asDouble).toBe(0.75)

    // failures: one int point per kind.
    const failures = byName.get('cat_factory.platform.run_failures')!
    const failByKind = Object.fromEntries(
      gaugePoints(failures).map((p) => [
        attrMap(p.attributes as KV[])['cat_factory.failure_kind'],
        Number(p.asInt),
      ]),
    )
    expect(failByKind).toEqual({ agent: 1, timeout: 1 })

    // live: a snapshot — points carry account but NOT the window label.
    const live = byName.get('cat_factory.platform.live_runs')!
    const liveByState = Object.fromEntries(
      gaugePoints(live).map((p) => {
        const a = attrMap(p.attributes as KV[])
        expect(a['cat_factory.window']).toBeUndefined()
        return [a['cat_factory.run_state'], Number(p.asInt)]
      }),
    )
    expect(liveByState).toEqual({ running: 3, blocked: 2, paused: 1, pending: 4 })

    // durations: ms → seconds, one double point per statistic.
    const durations = byName.get('cat_factory.platform.run_duration')!
    expect(durations.unit).toBe('s')
    const durByStat = Object.fromEntries(
      gaugePoints(durations).map((p) => [
        attrMap(p.attributes as KV[])['cat_factory.duration_stat'],
        (p as { asDouble: number }).asDouble,
      ]),
    )
    expect(durByStat).toEqual({ avg: 120, min: 30, max: 300, p50: 90, p90: 250, p99: 300 })
  })

  it('omits the success-rate, failures and duration gauges when there is nothing to report', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = new PlatformMetricsOtelExporter({ endpoint: COLLECTOR, fetchImpl })

    await exporter.export(
      snapshot({
        outcomes: {
          total: 0,
          done: 0,
          failed: 0,
          running: 0,
          blocked: 0,
          paused: 0,
          other: 0,
          successRate: null,
        },
        failures: [],
        durations: {
          count: 0,
          avgMs: null,
          minMs: null,
          maxMs: null,
          p50Ms: null,
          p90Ms: null,
          p99Ms: null,
        },
      }),
      { accountId: 'acc-empty' },
    )

    const names = metricsOf(calls[0]!.body).map((m) => String(m.name))
    // runs (all-zero) + live are always present; the null-bearing gauges are dropped.
    expect(names.sort()).toEqual(['cat_factory.platform.live_runs', 'cat_factory.platform.runs'])
  })

  it('never throws when the OTLP endpoint fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const warn = vi.fn()
    const exporter = new PlatformMetricsOtelExporter({
      endpoint: COLLECTOR,
      logger: { warn },
      fetchImpl,
    })

    await expect(exporter.export(snapshot(), { accountId: 'acc-1' })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
