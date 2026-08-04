import { afterEach, describe, expect, it } from 'vitest'
import { type OtelConfig, createPinoLogger, getLogSink, setLogSink } from '@cat-factory/server'
import {
  flushOtelLogsForIsolate,
  installOtelLogSink,
} from '../src/infrastructure/observability/logExport'

// Guards the per-facade WIRING of the OTLP log export on the Worker: that it gates on the
// config, that installing is per-ISOLATE and idempotent (a second entry point on the same
// isolate must reuse the buffer the first installed, not orphan it), and that the
// per-invocation flush actually POSTs. The exporter itself is unit tested in
// `@cat-factory/observability-otel`. Mirrors `runtimes/node/test/log-export-wiring.spec.ts`.

const ENDPOINT = 'http://collector.test:4318'

function otelConfig(overrides: Partial<OtelConfig['logs']> = {}): OtelConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    platformMetrics: { enabled: false, intervalMs: 60_000, window: '1h' },
    logs: { enabled: true, flushIntervalMs: 5_000, maxBatchSize: 128, ...overrides },
  }
}

function capturingFetch(): { urls: string[]; bodies: string[]; fetchImpl: typeof fetch } {
  const urls: string[] = []
  const bodies: string[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    bodies.push(String(init?.body))
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  return { urls, bodies, fetchImpl }
}

afterEach(() => setLogSink(null))

describe('Worker facade: OTLP log export wiring', () => {
  it('installs the sink for the isolate and flushes what it accumulated', async () => {
    const { urls, bodies, fetchImpl } = capturingFetch()
    const logger = createPinoLogger()
    const exporter = installOtelLogSink(otelConfig(), { logger, fetchImpl })

    expect(exporter).not.toBeNull()
    expect(getLogSink()).toBe(exporter)

    logger.child({ executionId: 'exec_wiring' }).info('worker log export probe')
    await flushOtelLogsForIsolate(otelConfig())

    expect(urls).toContain(`${ENDPOINT}/v1/logs`)
    expect(bodies.join('')).toContain('worker log export probe')
  })

  it('reuses the isolate’s exporter rather than replacing (and orphaning) its buffer', () => {
    const { fetchImpl } = capturingFetch()
    const logger = createPinoLogger()
    const first = installOtelLogSink(otelConfig(), { logger, fetchImpl })
    // A `scheduled` or `queue` invocation on the same isolate installs again; same instance.
    const second = installOtelLogSink(otelConfig(), { logger, fetchImpl })

    expect(second).toBe(first)
  })

  it('installs nothing, and schedules nothing, when OTEL_LOGS is not opted in', () => {
    const { fetchImpl } = capturingFetch()
    const config = otelConfig({ enabled: false })

    expect(installOtelLogSink(config, { fetchImpl })).toBeNull()
    expect(getLogSink()).toBeNull()
    expect(flushOtelLogsForIsolate(config)).toBeNull()
  })

  it('installs nothing when no endpoint is configured', () => {
    const config: OtelConfig = { ...otelConfig(), enabled: false, endpoint: undefined }

    expect(installOtelLogSink(config)).toBeNull()
    expect(flushOtelLogsForIsolate(config)).toBeNull()
  })
})
