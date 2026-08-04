import { describe, expect, it } from 'vitest'
import { type LogRecord, createRecordingLogger } from '@cat-factory/kernel'
import { DEFAULT_LOG_BATCH_SIZE, SELF_LOG_FIELD, createOtelLogExporter } from './logs.js'
import { mapLogRecord } from './mapping.js'

// The log exporter POSTs OTLP/JSON to `{endpoint}/v1/logs` over its injectable `fetchImpl`,
// same shape as the trace/metric exporters beside it (see `index.test.ts` for why a stub
// rather than a global dispatcher intercept).

const COLLECTOR = 'http://collector.test:4318'

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function capturingFetch(status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response('', { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function line(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    level: 'info',
    msg: 'execution advanced',
    fields: { workspaceId: 'ws1', executionId: 'exec1' },
    timeMs: 1_700_000_000_000,
    ...overrides,
  }
}

/** The `logRecords` array of one captured POST. */
function recordsOf(call: Call): Record<string, never>[] {
  const resourceLogs = (call.body as { resourceLogs: Record<string, never>[] }).resourceLogs
  return (resourceLogs[0] as unknown as { scopeLogs: { logRecords: Record<string, never>[] }[] })
    .scopeLogs[0]!.logRecords
}

describe('OtelLogExporter', () => {
  it('POSTs buffered lines to /v1/logs on flush, as OTLP log records', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({
      endpoint: `${COLLECTOR}/`,
      headers: { 'x-api-key': 'secret' },
      serviceName: 'cat-factory-test',
      fetchImpl,
    })

    exporter.record(line({ level: 'warn', msg: 'merge classification failed' }))
    expect(calls).toHaveLength(0) // nothing is sent until a batch fills or a flush runs

    await exporter.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${COLLECTOR}/v1/logs`)
    expect(calls[0]!.headers['x-api-key']).toBe('secret')
    const [record] = recordsOf(calls[0]!)
    expect(record).toMatchObject({
      severityNumber: 13,
      severityText: 'WARN',
      body: { stringValue: 'merge classification failed' },
      timeUnixNano: '1700000000000000000',
      observedTimeUnixNano: '1700000000000000000',
    })
    const resource = (calls[0]!.body as { resourceLogs: { resource: { attributes: unknown[] } }[] })
      .resourceLogs[0]!.resource
    expect(resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'cat-factory-test' },
    })
  })

  it('carries the line’s fields as attributes and joins the run’s trace', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, fetchImpl })

    exporter.record(
      line({ fields: { workspaceId: 'ws1', executionId: 'exec1', attempts: 3, ok: false } }),
    )
    await exporter.flush()

    const [record] = recordsOf(calls[0]!)
    expect((record as unknown as { attributes: unknown[] }).attributes).toEqual([
      { key: 'workspaceId', value: { stringValue: 'ws1' } },
      { key: 'executionId', value: { stringValue: 'exec1' } },
      { key: 'attempts', value: { intValue: '3' } },
      // A boolean stays a boolean: a backend filters `ok = false` and `ok = "false"` differently.
      { key: 'ok', value: { boolValue: false } },
    ])
    // The run's spans derive their trace id the same way, which is how logs and traces meet.
    expect((record as unknown as { traceId: string }).traceId).toBe(mapLogRecord(line()).traceId)
  })

  it('claims no trace for a line with no run', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, fetchImpl })

    exporter.record(line({ fields: { scope: 'boot' } }))
    await exporter.flush()

    expect(recordsOf(calls[0]!)[0]).not.toHaveProperty('traceId')
  })

  it('sends once a full batch has accumulated, without waiting for a flush', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, maxBatchSize: 4, fetchImpl })

    for (let i = 0; i < 4; i++) exporter.record(line({ msg: `line ${i}` }))
    // `record` never awaits; the send it started settles on the exporter's own chain.
    await exporter.flush()

    expect(calls).toHaveLength(1)
    expect(recordsOf(calls[0]!)).toHaveLength(4)
  })

  it('splits a backlog into batches of the configured size', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, maxBatchSize: 2, fetchImpl })

    for (let i = 0; i < 5; i++) exporter.record(line({ msg: `line ${i}` }))
    await exporter.flush()

    expect(calls.map((c) => recordsOf(c).length)).toEqual([2, 2, 1])
  })

  it('sends nothing when nothing was recorded', async () => {
    const { fetchImpl, calls } = capturingFetch()
    await createOtelLogExporter({ endpoint: COLLECTOR, fetchImpl }).flush()
    expect(calls).toHaveLength(0)
  })

  it('refuses to export its own failure reports, so an outage cannot feed itself', async () => {
    // A rejecting collector makes the exporter warn through its own logger; that warning must
    // not come back as a line to export, or a collector outage becomes a batch about itself.
    const { fetchImpl, calls } = capturingFetch(500)
    const logger = createRecordingLogger()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, logger, fetchImpl })

    exporter.record(line())
    await exporter.flush()
    // The warning reached the LOCAL writer (which is where an operator reads it) …
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
    // … carrying the field that makes the exporter refuse it.
    expect(logger.lines[0]!.fields[SELF_LOG_FIELD]).toBe(true)

    // Feeding that same line back is a no-op: nothing more is buffered, so nothing more is sent.
    const before = calls.length
    exporter.record(line({ level: 'warn', fields: { [SELF_LOG_FIELD]: true } }))
    await exporter.flush()
    expect(calls).toHaveLength(before)
  })

  it('never rejects when the collector fails', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const logger = createRecordingLogger()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, logger, fetchImpl: failing })

    exporter.record(line())
    await expect(exporter.flush()).resolves.toBeUndefined()
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('bounds the buffer and REPORTS what it dropped', async () => {
    // Nothing is delivered while the collector hangs, so the buffer fills to its cap and the
    // oldest lines go. The drop must be stated: a silently short stream reads like a quiet one.
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, maxBatchSize: 2, fetchImpl })
    const capacity = 2 * 8

    // Record without ever letting the send chain run (no awaits between).
    for (let i = 0; i < capacity + 3; i++) exporter.record(line({ msg: `line ${i}` }))
    await exporter.flush()

    const bodies = calls.flatMap((c) => recordsOf(c))
    const dropNote = bodies.find(
      (r) =>
        (r as unknown as { body: { stringValue: string } }).body.stringValue ===
        'otel: dropped buffered log records (export buffer full)',
    )
    expect(dropNote).toBeDefined()
    expect((dropNote as unknown as { attributes: unknown[] }).attributes).toContainEqual({
      key: 'dropped',
      value: { intValue: '3' },
    })
    // The lines that survived are the NEWEST ones, which is what an operator is looking at.
    const messages = bodies.map((r) => (r as unknown as { body: { stringValue: string } }).body)
    expect(messages).toContainEqual({ stringValue: `line ${capacity + 2}` })
    expect(messages).not.toContainEqual({ stringValue: 'line 0' })
  })

  it('defaults the batch size and service name', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const exporter = createOtelLogExporter({ endpoint: COLLECTOR, fetchImpl })

    for (let i = 0; i < DEFAULT_LOG_BATCH_SIZE; i++) exporter.record(line())
    await exporter.flush()

    expect(recordsOf(calls[0]!)).toHaveLength(DEFAULT_LOG_BATCH_SIZE)
    const resource = (calls[0]!.body as { resourceLogs: { resource: { attributes: unknown[] } }[] })
      .resourceLogs[0]!.resource
    expect(resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'cat-factory' },
    })
  })
})

describe('mapLogRecord', () => {
  it('maps every level onto its OTLP severity', () => {
    expect(
      (['debug', 'info', 'warn', 'error'] as const).map((level) => {
        const mapped = mapLogRecord(line({ level }))
        return [mapped.severityNumber, mapped.severityText]
      }),
    ).toEqual([
      [5, 'DEBUG'],
      [9, 'INFO'],
      [13, 'WARN'],
      [17, 'ERROR'],
    ])
  })

  it('omits a field carrying nothing rather than exporting an empty one', () => {
    const mapped = mapLogRecord(line({ fields: { a: null, b: undefined, c: '' } }))
    expect(mapped.attributes).toEqual({ c: '' })
  })

  it('serialises a structured value and survives one it cannot', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const mapped = mapLogRecord(line({ fields: { detail: { a: 1 }, list: ['x'], cyclic } }))
    expect(mapped.attributes.detail).toBe('{"a":1}')
    expect(mapped.attributes.list).toEqual(['x'])
    expect(String(mapped.attributes.cyclic)).toContain('unserializable')
  })

  it('caps an oversized value and says how much it cut', () => {
    const mapped = mapLogRecord(line({ fields: { stdout: 'x'.repeat(9_000) } }))
    const capped = String(mapped.attributes.stdout)
    expect(capped.startsWith('x'.repeat(8_192))).toBe(true)
    expect(capped).toContain('truncated 808 chars')
  })
})
