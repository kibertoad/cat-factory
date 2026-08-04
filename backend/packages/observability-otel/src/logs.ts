import {
  type MappedLogRecord,
  ATTR,
  DEFAULT_SERVICE_NAME,
  SCOPE_NAME,
  mapLogRecord,
  toUnixNano,
} from './mapping.js'
import { type KeyValue, keyValues, postOtlp } from './otlp.js'
import type { LogRecord, LogSink, Logger } from '@cat-factory/kernel'

// A fetch-based OpenTelemetry exporter for the platform's own LOG lines: the third OTLP
// signal this package publishes, beside the per-call traces/metrics (`./index`) and the
// deployment-level metrics (`./platform`). It implements the kernel `LogSink` port, so
// `@cat-factory/server`'s logging adapter fans every emitted line here in addition to
// writing it locally, and nothing in the domain learns that a second destination exists.
//
// Fetch on BOTH runtimes, like the platform exporter and for the same reason: the OTLP/HTTP
// logs encoding is a plain JSON POST, so the official SDK's log-record processor would buy
// nothing that this cannot do while ruling out the Worker (workerd cannot run it).
//
// Two shapes here are NOT the SDK's defaults, and both follow from the runtimes:
//
//   - **The buffer is drained by whoever holds it, not by a timer this owns.** Node runs an
//     interval; a Worker isolate flushes at the end of each invocation, because module state
//     there is per isolate and an isolate is discarded without notice. A timer started inside
//     the exporter would be the one thing a Worker cannot honour.
//   - **Delivery failures never reach the caller.** `record` only buffers (it runs on the emit
//     path of every line, including lines already reporting a failure) and `flush` resolves
//     even when the POST failed. A dropped batch is the documented worst case; the alternative
//     is observability that can break the thing it observes.

/**
 * The field this exporter binds onto the logger it reports its OWN failures through, and
 * refuses to export.
 *
 * Without it the pipeline feeds itself: a failed POST logs a warning, the adapter fans that
 * warning back into this buffer, the next flush fails the same way, and a collector outage
 * becomes an ever-growing batch of lines about a collector outage. The warning still reaches
 * the LOCAL writer, which is where an operator whose collector is down can actually read it.
 */
export const SELF_LOG_FIELD = 'otelLogExport'

/** Default lines per POST; also the size at which a full buffer triggers a send. */
export const DEFAULT_LOG_BATCH_SIZE = 128

/**
 * How many batches may sit unsent before the oldest lines are dropped. The buffer is the one
 * unbounded thing in this design (a collector that stops answering must not turn into a heap
 * that ends the process), so it is bounded here and the drop is REPORTED on the next batch out
 * rather than passing silently. A batch the collector then rejects takes its own drop note with
 * it, which loses nothing a reader had: that batch's lines are gone by the same failure.
 */
const MAX_QUEUED_BATCHES = 8

export interface OtelLogExporterConfig {
  /** OTLP/HTTP base URL, e.g. `http://collector:4318` (`/v1/logs` is appended). */
  endpoint: string
  /** Extra headers merged onto every request (auth tokens, tenant ids, …). */
  headers?: Record<string, string>
  /** OTLP resource `service.name`; defaults to `cat-factory`. */
  serviceName?: string
  /** Lines per POST; defaults to {@link DEFAULT_LOG_BATCH_SIZE}. */
  maxBatchSize?: number
  /**
   * Logger for this exporter's own swallowed failures. Bound with {@link SELF_LOG_FIELD}, so
   * those lines reach the local writer and are refused by the buffer (see the constant).
   */
  logger?: Logger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Encode one mapped record as an OTLP/JSON `LogRecord`. */
function encodeLogRecord(record: MappedLogRecord): Record<string, unknown> {
  const time = toUnixNano(record.timeMs)
  return {
    // Both stamps carry the emit time: the platform's lines are exported from the process
    // that produced them, so there is no collection lag to state as a separate observation.
    timeUnixNano: time,
    observedTimeUnixNano: time,
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: { stringValue: record.body },
    attributes: keyValues(record.attributes),
    ...(record.traceId ? { traceId: record.traceId } : {}),
  }
}

export class OtelLogExporter implements LogSink {
  private readonly logsEndpoint: string
  private readonly headers: Record<string, string>
  private readonly serviceName: string
  private readonly maxBatchSize: number
  private readonly logger?: Logger
  private readonly fetchImpl: typeof fetch

  /** Lines accepted but not yet POSTed. Bounded by `maxBatchSize * MAX_QUEUED_BATCHES`. */
  private buffer: LogRecord[] = []
  /** Lines dropped by the bound above since the last time the drop was reported. */
  private dropped = 0
  /**
   * The tail of the send chain. Sends are SERIALISED rather than issued concurrently, so a
   * batch-size trigger and a flush can never interleave two POSTs that both drained part of
   * the buffer. `flush()` awaiting this tail is also what lets a Worker's `waitUntil` cover a
   * send that started while the request was still being served.
   */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(config: OtelLogExporterConfig) {
    const base = config.endpoint.replace(/\/+$/, '')
    this.logsEndpoint = `${base}/v1/logs`
    this.headers = { 'content-type': 'application/json', ...config.headers }
    this.serviceName = config.serviceName || DEFAULT_SERVICE_NAME
    this.maxBatchSize =
      config.maxBatchSize && config.maxBatchSize > 0 ? config.maxBatchSize : DEFAULT_LOG_BATCH_SIZE
    this.logger = config.logger?.child({ [SELF_LOG_FIELD]: true })
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /**
   * Buffer one line, and start a send once a full batch has accumulated. Never throws and
   * never awaits: this runs inside `logger.info(…)`, so anything slower than an array push
   * would put the collector's latency on the caller's path.
   */
  record(record: LogRecord): void {
    if (record.fields[SELF_LOG_FIELD] === true) return
    const capacity = this.maxBatchSize * MAX_QUEUED_BATCHES
    if (this.buffer.length >= capacity) {
      // Drop the OLDEST: during an outage the newest lines are the ones an operator is
      // looking at, and the local writer still holds every one of them either way.
      const overflow = this.buffer.length - capacity + 1
      this.buffer.splice(0, overflow)
      this.dropped += overflow
    }
    this.buffer.push(record)
    if (this.buffer.length >= this.maxBatchSize) this.kick()
  }

  /**
   * Deliver everything buffered. Called on an interval by the Node facade and once per
   * invocation by the Worker; resolves once every send it started (and any already in flight)
   * has settled. Best-effort: it resolves rather than rejecting when delivery failed.
   */
  async flush(): Promise<void> {
    this.kick()
    await this.inFlight
  }

  /** Queue a drain behind whatever is already sending, keeping POSTs strictly serial. */
  private kick(): void {
    this.inFlight = this.inFlight.then(() => this.drain())
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxBatchSize)
      // The drop note rides the NEXT batch out rather than a POST of its own: it is a fact
      // about this exporter, so it is worth exactly one line, next to the lines that survived.
      const dropped = this.dropped
      this.dropped = 0
      const mapped = batch.map(mapLogRecord)
      if (dropped > 0) mapped.push(droppedNote(dropped, batch[batch.length - 1]!.timeMs))
      await this.post(mapped)
    }
  }

  private async post(records: MappedLogRecord[]): Promise<void> {
    await postOtlp({
      fetchImpl: this.fetchImpl,
      endpoint: this.logsEndpoint,
      headers: this.headers,
      payload: {
        resourceLogs: [
          {
            resource: { attributes: this.resourceAttributes() },
            scopeLogs: [{ scope: { name: SCOPE_NAME }, logRecords: records.map(encodeLogRecord) }],
          },
        ],
      },
      logger: this.logger,
    })
  }

  private resourceAttributes(): KeyValue[] {
    return [{ key: ATTR.serviceName, value: { stringValue: this.serviceName } }]
  }
}

/**
 * The record standing in for what the buffer bound above discarded. Emitted INTO the export
 * rather than only logged locally, because a reader querying the collector is exactly the
 * reader who would otherwise take an incomplete stream for a complete one.
 */
function droppedNote(dropped: number, timeMs: number): MappedLogRecord {
  return mapLogRecord({
    level: 'warn',
    msg: 'otel: dropped buffered log records (export buffer full)',
    fields: { scope: 'otel-logs', dropped },
    // Stamped with the last line of the batch it rides out on rather than a clock read here:
    // the exporter reads no clock of its own (a Worker's is frozen between I/O anyway), and
    // the batch's own time is when the drop was actually happening.
    timeMs,
  })
}

/** Build a fetch-based {@link OtelLogExporter}. The workerd-safe opt-in log sink. */
export function createOtelLogExporter(config: OtelLogExporterConfig): OtelLogExporter {
  return new OtelLogExporter(config)
}
