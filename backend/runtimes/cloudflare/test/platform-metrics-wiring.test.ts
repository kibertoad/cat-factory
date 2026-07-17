import { describe, expect, it, vi } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import type { Workspace } from '@cat-factory/kernel'
import type { PlatformObservabilityService } from '@cat-factory/orchestration'
import type { Logger, OtelConfig } from '@cat-factory/server'
import { runPlatformMetricsSweep } from '../src/infrastructure/observability/platformMetrics'

// Guards the per-facade WIRING of the platform-metrics OTLP push on the Worker (the cron
// side of the runtime-symmetric sweep). The exporter + shared sweep driver are unit-tested
// in their own packages; this proves the Worker `runPlatformMetricsSweep` gates on the
// config and, when opted in, actually POSTs OTLP gauges to the configured endpoint — the
// glue the cross-runtime conformance suite can't see (it never boots the OTel exporter).
// Mirrors `runtimes/node/test/platform-metrics-wiring.spec.ts`.

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

const observability = {
  summarize: async () => snapshot(),
} as unknown as PlatformObservabilityService
const workspaceRepository = {
  listVisible: async () => [{ accountId: 'acc-1' } as Workspace, { accountId: null } as Workspace],
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function capturingFetch(): { urls: string[]; fetchImpl: typeof fetch } {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  return { urls, fetchImpl }
}

describe('Worker facade: platform-metrics OTLP sweep wiring', () => {
  it('POSTs OTLP gauges to /v1/metrics when opted in', async () => {
    const { urls, fetchImpl } = capturingFetch()
    const sweep = runPlatformMetricsSweep({
      otel: otelConfig(),
      platformObservability: observability,
      workspaceRepository,
      logger: log,
      fetchImpl,
    })
    expect(sweep).not.toBeNull()
    await sweep
    expect(urls).toContain(`${ENDPOINT}/v1/metrics`)
  })

  it('returns null (nothing scheduled) when platformMetrics is disabled', () => {
    const { fetchImpl } = capturingFetch()
    const sweep = runPlatformMetricsSweep({
      otel: otelConfig({ enabled: false }),
      platformObservability: observability,
      workspaceRepository,
      logger: log,
      fetchImpl,
    })
    expect(sweep).toBeNull()
  })

  it('returns null when the platform-observability read is unwired', () => {
    const { fetchImpl } = capturingFetch()
    const sweep = runPlatformMetricsSweep({
      otel: otelConfig(),
      platformObservability: undefined,
      workspaceRepository,
      logger: log,
      fetchImpl,
    })
    expect(sweep).toBeNull()
  })

  it('returns null when no endpoint is configured', () => {
    const { fetchImpl } = capturingFetch()
    const sweep = runPlatformMetricsSweep({
      otel: {
        enabled: false,
        endpoint: undefined,
        platformMetrics: { enabled: true, intervalMs: 60_000, window: '1h' },
      },
      platformObservability: observability,
      workspaceRepository,
      logger: log,
      fetchImpl,
    })
    expect(sweep).toBeNull()
  })
})
