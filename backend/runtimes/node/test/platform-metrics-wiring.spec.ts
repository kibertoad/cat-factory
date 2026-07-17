import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import type { Clock, Workspace } from '@cat-factory/kernel'
import type { PlatformObservabilityService } from '@cat-factory/orchestration'
import type { OtelConfig } from '@cat-factory/server'
import { startPlatformMetricsSweeper } from '../src/platformMetrics.js'

// Guards the per-facade WIRING of the platform-metrics OTLP push (the Node side of the
// runtime-symmetric sweep). The exporter + sweep driver are unit-tested in their own
// packages; this proves the Node `startPlatformMetricsSweeper` gates on the config and,
// when enabled, actually POSTs OTLP gauges to the configured endpoint — the glue the
// cross-runtime conformance suite can't see (it never boots the OTel exporter).

const ENDPOINT = 'http://collector.test:4318'

function snapshot(): PlatformObservability {
  return {
    window: '1h',
    generatedAt: 1_700_000_000_000,
    since: 0,
    outcomes: {
      total: 1,
      done: 1,
      failed: 0,
      running: 0,
      blocked: 0,
      paused: 0,
      other: 0,
      successRate: 1,
    },
    trend: { bucketMs: 1_000, points: [] },
    failures: [],
    live: { running: 0, blocked: 0, paused: 0, pending: 0 },
    durations: {
      count: 0,
      avgMs: null,
      minMs: null,
      maxMs: null,
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
    },
  }
}

function otelConfig(overrides: Partial<OtelConfig['platformMetrics']> = {}): OtelConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    platformMetrics: { enabled: true, intervalMs: 60_000, window: '1h', ...overrides },
  }
}

const clock: Clock = { now: () => 1_700_000_000_000 }
const observability = {
  summarize: async () => snapshot(),
} as unknown as PlatformObservabilityService
const workspaceRepository = {
  listVisible: async () => [{ accountId: 'acc-1' } as Workspace, { accountId: null } as Workspace],
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
})

function capturingFetch(): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch)
  return { urls }
}

describe('Node facade: platform-metrics OTLP sweep wiring', () => {
  it('POSTs OTLP gauges to /v1/metrics when enabled', async () => {
    const { urls } = capturingFetch()
    stops.push(
      startPlatformMetricsSweeper(
        { otel: otelConfig(), platformObservability: observability, workspaceRepository },
        clock,
        log,
      ),
    )
    // `startSweeper` runs the first tick immediately (runImmediately) but asynchronously.
    await vi.waitFor(() => expect(urls).toContain(`${ENDPOINT}/v1/metrics`))
  })

  it('is a no-op when platformMetrics is disabled', async () => {
    const { urls } = capturingFetch()
    stops.push(
      startPlatformMetricsSweeper(
        {
          otel: otelConfig({ enabled: false }),
          platformObservability: observability,
          workspaceRepository,
        },
        clock,
        log,
      ),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(urls).toEqual([])
  })

  it('is a no-op when no endpoint is configured', async () => {
    const { urls } = capturingFetch()
    stops.push(
      startPlatformMetricsSweeper(
        {
          otel: {
            enabled: false,
            endpoint: undefined,
            platformMetrics: { enabled: true, intervalMs: 60_000, window: '1h' },
          },
          platformObservability: observability,
          workspaceRepository,
        },
        clock,
        log,
      ),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(urls).toEqual([])
  })
})
