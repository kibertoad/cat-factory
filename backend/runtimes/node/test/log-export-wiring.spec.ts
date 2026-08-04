import { afterEach, describe, expect, it } from 'vitest'
import { type OtelConfig, getLogSink, logger, setLogSink } from '@cat-factory/server'
import { startOtelLogExport } from '../src/logExport.js'

// Guards the per-facade WIRING of the OTLP log export on Node: that it gates on the config,
// that an opted-in deployment actually installs the sink on the shared logging adapter, and
// that stopping it delivers what is still buffered and detaches. The exporter itself is unit
// tested in `@cat-factory/observability-otel`; this is the glue no other suite can see.
// Mirrors `runtimes/cloudflare/test/log-export-wiring.test.ts`.

const ENDPOINT = 'http://collector.test:4318'

function otelConfig(overrides: Partial<OtelConfig['logs']> = {}): OtelConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    platformMetrics: { enabled: false, intervalMs: 60_000, window: '1h' },
    logs: { enabled: true, flushIntervalMs: 60_000, maxBatchSize: 128, ...overrides },
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

// The sink is module state in `@cat-factory/server`; leave it clean for every other suite.
afterEach(() => setLogSink(null))

describe('Node facade: OTLP log export wiring', () => {
  it('installs the sink and POSTs the buffered lines to /v1/logs on stop', async () => {
    const { urls, bodies, fetchImpl } = capturingFetch()
    const handle = startOtelLogExport(otelConfig(), logger, { fetchImpl })

    expect(getLogSink()).not.toBeNull()
    logger.child({ workspaceId: 'ws_wiring' }).warn('log export wiring probe')
    await handle.stop()

    expect(urls).toContain(`${ENDPOINT}/v1/logs`)
    expect(bodies.join('')).toContain('log export wiring probe')
    // Stopping detaches, so a later line cannot buffer into an exporter nobody will flush.
    expect(getLogSink()).toBeNull()
  })

  it('gives up on the final flush rather than outliving its SIGTERM grace period', async () => {
    // A collector that accepts the connection and never answers. Unbounded, `stop()` would
    // wait out the transport timeout once per queued batch, pushing a shutdown past the
    // grace period a supervisor allows and getting SIGKILLed: the shutdown lines this flush
    // exists to deliver would be lost along with every other stop's.
    const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const handle = startOtelLogExport(otelConfig(), logger, { fetchImpl: hanging })

    logger.warn('shutting down')
    const startedAt = Date.now()
    await handle.stop()

    // Resolved on the deadline (5s), not on the transport's own 10s-per-batch ceiling.
    expect(Date.now() - startedAt).toBeLessThan(9_000)
    expect(getLogSink()).toBeNull()
  }, 20_000)

  it('is a no-op when OTEL_LOGS is not opted in', async () => {
    const { urls, fetchImpl } = capturingFetch()
    const handle = startOtelLogExport(otelConfig({ enabled: false }), logger, { fetchImpl })

    logger.info('not exported')
    await handle.stop()

    expect(getLogSink()).toBeNull()
    expect(urls).toEqual([])
  })

  it('is a no-op when no endpoint is configured', async () => {
    const { urls, fetchImpl } = capturingFetch()
    const handle = startOtelLogExport(
      { ...otelConfig(), enabled: false, endpoint: undefined },
      logger,
      { fetchImpl },
    )

    logger.info('not exported')
    await handle.stop()

    expect(getLogSink()).toBeNull()
    expect(urls).toEqual([])
  })
})
